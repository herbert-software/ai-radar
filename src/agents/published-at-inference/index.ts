/**
 * 发布时间推断 Agent（published-at-inference 1.2 / 1.3，design D2）。
 *
 * 职责：对 `published_at` 为 NULL 的事件，从其代表 raw_item 的线索（title / canonical_url /
 * 正文或摘要 / 源）语义推断文章发布日期。镜像 value-judge/index.ts 的依赖注入 / 重试 /
 * 超时 / 降级范式：
 * - `generateObjectFn` 可注入（默认真实 Vercel AI SDK），使测试不依赖真实 key。
 * - `maxAttempts` 默认 3（首次 + 2 次重试），复用项目既有 LLM 调用约定。
 * - 单次调用 `AbortSignal.timeout(env.LLM_TIMEOUT_MS)` 超时（防挂起卡死回填阶段）。
 * - `logError` 可注入，便于测试断言「降级被记录、非静默」。
 *
 * **降级总原则（与 value-judge 的关键差异）**：published-at-inference 是兜底语义抽取，
 * 「判不出」是预期高比例的**安全失败方向**。故本函数**不抛降级信号**（不同于 judgeRawItem
 * 抛 ValueJudgeFailureError）——LLM 调用失败 / 超时 / schema 校验失败 / 范围越界，一律
 * 记 error 日志后**返回 null（无法判定）**，绝不回填 now()/fetchedAt、绝不抛断流水线。
 * 回填编排（backfill.ts）据此「null 即跳过该事件」，与候选过滤层「NULL 即排除」自洽。
 */
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../../config/env.js';
import { makePublishedAtInferenceSchema } from './schema.js';

export { makePublishedAtInferenceSchema, REASONABLE_LOWER_BOUND } from './schema.js';
export type { PublishedAtInferenceOutput } from './schema.js';

/**
 * `generateObject` 的最小依赖契约（仅取本 Agent 用到的形参/返回）。
 * 注入此类型使测试可 mock，不依赖真实 LLM。schema 用 `unknown`（实际是按 now 构造的实例）。
 */
export type GenerateObjectFn = (args: {
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  schema: ReturnType<typeof makePublishedAtInferenceSchema>;
  prompt: string;
}) => Promise<{ object: unknown }>;

/** 一条待推断发布时间的代表 raw_item 线索（经 representative_raw_item_id 回指 raw_items）。 */
export interface InferPublishedAtInput {
  /** raw_item 标题（构成 prompt 主体）。 */
  title: string;
  /** 规范化 URL（含路径常带日期线索，如 /2021/05/...）。 */
  canonicalUrl?: string | null;
  /** raw_item 正文/摘要（可选，线索来源之一）。 */
  content?: string | null;
  /** 来源标识（可选，供 prompt 上下文，如 openai_blog / arxiv）。 */
  source?: string | null;
}

export interface InferPublishedAtOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言。 */
  logError?: (message: string, detail: unknown) => void;
  /** 当前参考时刻（合理范围上界），默认 new Date()。测试注入以固化「未来日期被拒」边界。 */
  now?: Date;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 真实 SDK 适配：保留宽松签名以便依赖注入；加 abortSignal 超时。 */
const defaultGenerateObject: GenerateObjectFn = (args) =>
  generateObject({
    ...args,
    abortSignal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
  }) as unknown as Promise<{ object: unknown }>;

function buildModel(): ReturnType<ReturnType<typeof createOpenAI>> {
  const provider = createOpenAI({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    headers: { 'X-Title': 'ai-radar' },
  });
  return provider(env.LLM_MODEL);
}

function buildPrompt(input: InferPublishedAtInput, now: Date): string {
  const parts = [
    'You are an AI-industry intelligence analyst. Infer the original PUBLICATION DATE of the ' +
      'following article from the available clues (title, URL path, body, source). ' +
      'Return structured JSON.',
    `Title: ${input.title}`,
  ];
  if (input.canonicalUrl) parts.push(`URL: ${input.canonicalUrl}`);
  if (input.content) parts.push(`Content: ${input.content}`);
  if (input.source) parts.push(`Source: ${input.source}`);
  parts.push(
    `Current time (UTC): ${now.toISOString()}.`,
    'Rules: publishedAt must be an ISO 8601 date/datetime no later than the current time and no ' +
      'earlier than 1990-01-01. If you cannot determine the publication date with reasonable ' +
      'confidence, return publishedAt: null. Do NOT guess "now" or fabricate a date.',
    'Fields: publishedAt (ISO string or null), confidence (0-1, optional), basis (optional).',
  );
  return parts.join('\n');
}

/**
 * 对一条事件的代表 raw_item 线索推断发布时间。
 *
 * 成功（返回通过合理范围校验的明确 ISO 日期串）：返回该 ISO 串。
 * 无法判定 / LLM 失败 / 超时 / schema 校验失败 / 范围越界：记日志 + **返回 null**（降级），
 * 绝不抛、绝不回填臆造时间。范围越界由 schema 的 transform 归一为 null（见 schema.ts）。
 *
 * @returns 推断出的合法 ISO 日期串（在 [下限, now] 内），或 null（无法判定/降级）。
 */
export async function inferPublishedAt(
  input: InferPublishedAtInput,
  options: InferPublishedAtOptions = {},
): Promise<string | null> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = options.now ?? new Date();
  const logError =
    options.logError ??
    ((message, detail) =>
      console.error(`[published-at-inference] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input, now);
  // 按 now 构造范围 schema：上界 = now（拒未来），下界 = 合理下限（拒荒谬过早）。
  const schema = makePublishedAtInferenceSchema(now);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({ model, schema, prompt });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保越界/非法值已被 transform 归一为 null。
      const parsed = schema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：输出未通过 Zod 校验`,
          parsed.error.issues,
        );
        continue;
      }
      // publishedAt 经 transform 已是「合法 ISO 串（范围内）或 null」；null = 无法判定（含越界归一）。
      return parsed.data.publishedAt;
    } catch (error) {
      lastError = error;
      logError(
        `第 ${attempt}/${maxAttempts} 次：generateObject 调用失败`,
        error,
      );
    }
  }

  // 有限重试耗尽：降级为「无法判定（null）」，记日志、不抛断（与 value-judge 抛降级信号不同——
  // 发布时间判不出是预期安全失败方向，由候选过滤层「NULL 即排除」兜底）。
  logError(
    `在 ${maxAttempts} 次尝试后仍无法推断发布时间，降级为无法判定（NULL，不回填）`,
    lastError,
  );
  return null;
}
