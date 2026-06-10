/**
 * Value Judge Agent 雏形（任务 5.2 / 5.3）——P1 可复用的 Agent 骨架。
 *
 * 职责：
 * - 经 Vercel AI SDK `generateObject` 调用 LLM（provider/model 从 env 注入）。
 * - 以 ./schema.ts 的 Zod schema 约束并校验输出。
 * - 校验失败处理（5.3，关键不变量）：记录 error 日志 + 有限重试，仍失败则降级
 *   抛出 ValueJudgeFailureError，绝不静默吞掉、绝不返回/落库未校验数据。
 *
 * 依赖注入：`generateObject` 经参数注入（默认用真实 SDK），
 * 使 vitest 可在不依赖真实 key 的前提下覆盖成功/失败路径。
 */
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../../config/env.js';
import { valueJudgeOutputSchema, type ValueJudgeOutput } from './schema.js';

export { valueJudgeOutputSchema };
export type { ValueJudgeOutput };

/**
 * 有限重试后仍无法得到经校验输出时抛出的降级信号。
 * 调用方据此降级（不写库），而非把失败当成功。
 */
export class ValueJudgeFailureError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'ValueJudgeFailureError';
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
  schema: typeof valueJudgeOutputSchema;
  prompt: string;
}) => Promise<{ object: unknown }>;

export interface JudgeRawItemInput {
  /** raw_item 标题（必填，构成 prompt 主体）。 */
  title: string;
  /** raw_item 正文/摘要（可选）。 */
  content?: string | null;
  /** 来源标识（可选，供 prompt 上下文）。 */
  source?: string | null;
}

export interface JudgeOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言。 */
  logError?: (message: string, detail: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/** 真实 SDK 适配：保留宽松签名以便依赖注入。 */
const defaultGenerateObject: GenerateObjectFn = (args) =>
  generateObject(args) as unknown as Promise<{ object: unknown }>;

function buildModel(): ReturnType<ReturnType<typeof createOpenAI>> {
  const provider = createOpenAI({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    headers: { 'X-Title': 'ai-radar' },
  });
  return provider(env.LLM_MODEL);
}

function buildPrompt(input: JudgeRawItemInput): string {
  const parts = [
    'You are an AI-industry intelligence analyst. Judge the following item and return structured JSON.',
    `Title: ${input.title}`,
  ];
  if (input.content) parts.push(`Content: ${input.content}`);
  if (input.source) parts.push(`Source: ${input.source}`);
  parts.push(
    'Fields: is_ai_related, type, category, importance(0-100), novelty(0-100), developer_relevance(0-100), hype_risk(0-100), should_push, reason.',
  );
  return parts.join('\n');
}

/**
 * 对一条 raw_item 产出经 Zod 校验的结构化价值判断。
 *
 * 成功：返回经 valueJudgeOutputSchema 校验通过的对象。
 * 失败：所有尝试都因调用抛错或 Zod 校验不过而失败 → 记日志 + 抛
 *       ValueJudgeFailureError（降级信号），绝不返回未校验数据。
 */
export async function judgeRawItem(
  input: JudgeRawItemInput,
  options: JudgeOptions = {},
): Promise<ValueJudgeOutput> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[value-judge] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({
        model,
        schema: valueJudgeOutputSchema,
        prompt,
      });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保未校验数据绝不外泄。
      const parsed = valueJudgeOutputSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：输出未通过 Zod 校验`,
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

  // 有限重试耗尽 → 降级（抛出），由调用方决定不写库。绝不静默吞掉。
  throw new ValueJudgeFailureError(
    `Value Judge 在 ${maxAttempts} 次尝试后仍无法产出经校验的输出，已降级（不写库）。`,
    maxAttempts,
    lastError,
  );
}
