/**
 * 经验提炼 Agent（任务 3.2，capability: blogger-experience-mining）。
 *
 * 与 value-judge / digest 同规格（design D5 范式）：
 * - 经 Vercel AI SDK `generateObject` 调用 LLM（provider/model 从 env 注入）。
 * - 以 ./schema.ts 的 Zod schema 约束并校验输出（一次调用同出卡片 + long_term_value，design D5）。
 * - 校验失败处理（关键不变量，spec「校验失败或评分越界不写脏数据」）：记 error 日志 +
 *   有限重试，仍失败（缺字段/类型不符/long_term_value 越界）则降级抛出
 *   ExperienceMiningFailureError，绝不静默吞掉、绝不返回未校验或越界脏卡片。
 *
 * 偏离说明（design D5，诚实标注）：现有架构 score 与 summary 是分开两次 LLM 调用，本 Agent
 * 一次 generateObject 同出卡片 + 评分，是有意偏离（经验价值强依赖提炼内容，合并省一次调用）。
 *
 * 纯函数式边界（本组 C 范围）：输入（raw item 文本）→ 输出**经 Zod 校验的卡片对象**
 * （含 long_term_value）。**本 Agent 不写 DB**——写 `ai_experiences`、KB 沉淀、推送由组 D/E 负责；
 * 来源 URL 是确定性的 `canonical_source_url`（不由本 Agent 产出，schema 亦无该字段）。
 *
 * 依赖注入：`generateObject` 经参数注入（默认用真实 SDK），
 * 使 vitest 可在不依赖真实 key 的前提下覆盖成功/失败/越界路径。
 */
import { buildModel, defaultGenerateObject } from '../llm-client.js';
import type { LlmModel } from '../llm-client.js';
import { env } from '../../config/env.js';
import { experienceCardSchema, type ExperienceCard } from './schema.js';

export { experienceCardSchema };
export type { ExperienceCard };

/**
 * 有限重试后仍无法得到经校验卡片时抛出的降级信号。
 * 调用方（组 D 编排）据此降级（不写 `ai_experiences`），而非把失败当成功。
 */
export class ExperienceMiningFailureError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'ExperienceMiningFailureError';
    this.attempts = attempts;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * `generateObject` 的最小依赖契约（仅取本 Agent 用到的形参/返回）。
 * 注入此类型使测试可 mock，不依赖真实 LLM。
 */
export type GenerateObjectFn = (args: {
  model: LlmModel;
  schema: typeof experienceCardSchema;
  prompt: string;
}) => Promise<{ object: unknown }>;

export interface MineExperienceInput {
  /** 经验类 raw_item 标题（必填，构成 prompt 主体）。 */
  title: string;
  /**
   * 经验类 raw_item 正文（transcript / 博文；可选）。
   * 提炼前按 env.EXPERIENCE_TEXT_MAX_CHARS 截断（防 token 爆，design 风险/权衡）。
   */
  content?: string | null;
  /** 来源标识（可选，供 prompt 上下文；非卡片字段）。 */
  source?: string | null;
}

export interface MineExperienceOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言。 */
  logError?: (message: string, detail: unknown) => void;
  /** 正文截断字符数，默认 env.EXPERIENCE_TEXT_MAX_CHARS（镜像 EMBEDDING_TEXT_MAX_CHARS）。 */
  maxChars?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 构造提炼 prompt。正文按 maxChars 截断（镜像 buildEmbeddingText 的截断范式，design 风险/权衡）。
 */
function buildPrompt(input: MineExperienceInput, maxChars: number): string {
  const parts = [
    '你是 AI 工具实践经验分析师。请从下面这条 AI 博主内容中提炼出一张结构化「经验卡片」，用简体中文输出。',
    '要求：只提炼可复用的实战经验与做法，不堆砌营销词、不夸张；只返回结构化 JSON。',
    `标题：${input.title}`,
  ];

  const content = (input.content ?? '').trim();
  if (content.length > 0) {
    // 截断超长 transcript/博文：超过 maxChars 取前缀，防 token 爆（design 风险/权衡）。
    const truncated =
      content.length > maxChars ? content.slice(0, maxChars) : content;
    parts.push(`正文：${truncated}`);
  }
  if (input.source) parts.push(`来源：${input.source}`);

  parts.push(
    '字段：scenario（适用场景）；tools（涉及的 AI 工具，字符串数组，可为空数组）；' +
      'techniques（具体做法或技巧）；applicability（适用条件或前提）；' +
      'long_term_value（长期价值分，0–100 整数）；headline_zh（一句话要点）；summary_zh（中文摘要正文）。' +
      '不要返回来源链接（来源由系统确定性写入）。',
  );
  return parts.join('\n');
}

/**
 * 对一条经验类条目产出经 Zod 校验的经验卡片（含 long_term_value）。
 *
 * 成功：返回经 experienceCardSchema 校验通过的卡片对象。
 * 失败：所有尝试都因调用抛错、Zod 校验不过或 long_term_value 越界而失败 → 记日志 + 抛
 *       ExperienceMiningFailureError（降级信号），绝不返回未校验或越界脏卡片。
 *       调用方（组 D）据此降级、不写 `ai_experiences`。
 */
export async function mineExperience(
  input: MineExperienceInput,
  options: MineExperienceOptions = {},
): Promise<ExperienceCard> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxChars = options.maxChars ?? env.EXPERIENCE_TEXT_MAX_CHARS;
  const logError =
    options.logError ??
    ((message, detail) =>
      console.error(`[experience-mining] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input, maxChars);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({
        model,
        schema: experienceCardSchema,
        prompt,
      });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保未校验/越界卡片绝不外泄。
      const parsed = experienceCardSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：经验卡片未通过 Zod 校验（缺字段/类型/越界）`,
          parsed.error.issues,
        );
        continue;
      }
      return parsed.data;
    } catch (error) {
      lastError = error;
      logError(
        `第 ${attempt}/${maxAttempts} 次：generateObject 调用失败`,
        error,
      );
    }
  }

  // 有限重试耗尽 → 降级（抛出），由调用方决定不写 ai_experiences。绝不静默吞掉。
  throw new ExperienceMiningFailureError(
    `经验提炼 Agent 在 ${maxAttempts} 次尝试后仍无法产出经校验的卡片，已降级（不写库）。`,
    maxAttempts,
    lastError,
  );
}
