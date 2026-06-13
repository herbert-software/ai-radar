/**
 * 中文摘要 Agent（任务 7.1，capability: chinese-digest-agent）。
 *
 * 与 value-judge 同规格（design D9）：
 * - 经 Vercel AI SDK `generateObject` 调用 LLM（provider/model 从 env 注入）。
 * - 以 ./schema.ts 的 Zod schema 约束并校验输出（含 `summary_zh`）。
 * - 校验失败处理（关键不变量）：记 error 日志 + 有限重试，仍失败则降级抛出
 *   DigestFailureError，绝不静默吞掉、绝不返回未校验或半截输出。
 *
 * 依赖注入：`generateObject` 经参数注入（默认用真实 SDK），
 * 使 vitest 可在不依赖真实 key 的前提下覆盖成功/失败路径。
 *
 * 边界：本模块只产出经校验的摘要对象；落库（UPDATE summary_zh）与降级回退
 * （representative_title / 剔除）由 ./persistence.ts 实现。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { buildModel, defaultGenerateObject } from '../llm-client.js';
import { digestOutputSchema, HEADLINE_MAX, type DigestOutput } from './schema.js';

export { digestOutputSchema };
export type { DigestOutput };

/**
 * 有限重试后仍无法得到经校验摘要时抛出的降级信号。
 * 调用方据此降级（回退 representative_title 或剔除该 event），而非把失败当成功。
 */
export class DigestFailureError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'DigestFailureError';
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
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  schema: typeof digestOutputSchema;
  prompt: string;
}) => Promise<{ object: unknown }>;

export interface SummarizeEventInput {
  /** 事件代表标题（必填，构成 prompt 主体）。 */
  title: string;
  /** 事件正文/原文摘要（可选，供 prompt 上下文）。 */
  content?: string | null;
  /** 来源标识（可选，供 prompt 上下文）。 */
  source?: string | null;
}

export interface SummarizeOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言。 */
  logError?: (message: string, detail: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function buildPrompt(input: SummarizeEventInput): string {
  const parts = [
    '你是 AI 行业情报分析师。请用简体中文为下面这条事件生成结构化输出。',
    '要求：只陈述事实与对开发者的影响，不夸张、不堆砌营销词；摘要控制在约 1000 字以内；只返回结构化 JSON。',
    `标题：${input.title}`,
  ];
  if (input.content) parts.push(`正文：${input.content}`);
  if (input.source) parts.push(`来源：${input.source}`);
  parts.push(
    '字段：summary_zh（中文摘要正文）；' +
      `headline_zh（一句话要点，含主体+动作+影响，≤${HEADLINE_MAX} 字）。`,
  );
  return parts.join('\n');
}

/**
 * 对一条入选事件产出经 Zod 校验的中文摘要。
 *
 * 成功：返回经 digestOutputSchema 校验通过的对象（含非空 summary_zh）。
 * 失败：所有尝试都因调用抛错或 Zod 校验不过而失败 → 记日志 + 抛 DigestFailureError
 *       （降级信号），绝不返回未校验或半截输出。
 */
export async function summarizeEvent(
  input: SummarizeEventInput,
  options: SummarizeOptions = {},
): Promise<DigestOutput> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[digest] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({
        model,
        schema: digestOutputSchema,
        prompt,
      });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保未校验/半截输出绝不外泄。
      const parsed = digestOutputSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：摘要输出未通过 Zod 校验`,
          parsed.error.issues,
        );
        continue;
      }
      return parsed.data;
    } catch (error) {
      lastError = error;
      logError(`第 ${attempt}/${maxAttempts} 次：generateObject 调用失败`, error);
    }
  }

  // 有限重试耗尽 → 降级（抛出），由调用方决定回退 representative_title 或剔除。绝不静默吞掉。
  throw new DigestFailureError(
    `中文摘要 Agent 在 ${maxAttempts} 次尝试后仍无法产出经校验的摘要，已降级（不写库）。`,
    maxAttempts,
    lastError,
  );
}
