/**
 * 知识摘要 Agent（add-semantic-dedup-and-store-hardening，组 E / spec「知识摘要 Agent 产出入库元数据」，
 * QA.md §10.7 Knowledge Ingestion Agent）。
 *
 * 职责：对一条高价值候选事件，经 Vercel AI SDK `generateObject` + Zod 产出经校验的结构化入库元数据
 * `{ kb_title, summary_zh, tags[], entities[], source_urls[], event_date, long_term_value }`，供程序据此
 * 把内容沉淀进本地表知识库（**实际入库由程序执行**，LLM 仅产元数据 / QA §10.7）。
 *
 * 关键不变量（逐条守住，spec / design D7）：
 * - `long_term_value` 的 Zod **必须**钉死 `number().int().min(0).max(100)`——防越界值（如 200 / 负数）
 *   绕过 `>= 70` 准入闸语义；越界即视为校验不过、跳过该条（与 value-judge scoreField 同口径）。
 * - 属外部 API 调用，必须带**重试 + 错误日志**（照 value-judge judgeRawItem 范式）。
 * - 输出未通过 Zod 校验（或重试耗尽）→ 抛降级信号 `KbIngestionAgentFailureError`，由调用方
 *   **跳过该条、不入库**（不污染知识库），**不得中止整批**。绝不返回 / 落库未校验数据。
 *
 * 依赖注入：`generateObject` 经 `generateObjectFn` 注入（默认真实 SDK，照 value-judge 范式）；
 * 测试注入桩不触网（defaultGenerateObject 在 VITEST 下 throw 兜底）。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { buildModel, defaultGenerateObject } from '../agents/llm-client.js';
import { kbIngestionMetadataSchema, type KbIngestionMetadata } from './schema.js';

export { kbIngestionMetadataSchema };
export type { KbIngestionMetadata };

/**
 * 有限重试后仍无法得到经校验输出时抛出的降级信号。
 * 调用方据此跳过该条（不入库），而非把失败当成功（照 ValueJudgeFailureError 范式）。
 */
export class KbIngestionAgentFailureError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'KbIngestionAgentFailureError';
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
  schema: typeof kbIngestionMetadataSchema;
  prompt: string;
}) => Promise<{ object: unknown }>;

/** 知识摘要 Agent 的候选事件输入视图（构成 prompt 主体）。 */
export interface KbIngestionInput {
  /** 事件代表标题（必填，构成 prompt 主体）。 */
  representativeTitle: string;
  /** 事件中文摘要（可选，digest 阶段已产出，供 Agent 参考）。 */
  summaryZh?: string | null;
  /** 代表 raw_item 正文/摘录（可选，供 Agent 提取实体/标签）。 */
  content?: string | null;
  /** 来源 URL（可选，作为 source_urls 候选；Agent 也可只回传已知 URL）。 */
  sourceUrls?: readonly string[];
}

export interface KbIngestionAgentOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function buildPrompt(input: KbIngestionInput): string {
  const parts = [
    'You are an AI-industry knowledge curator. Distill the following event into a durable knowledge-base entry and return structured JSON.',
    `Title: ${input.representativeTitle}`,
  ];
  if (input.summaryZh) parts.push(`Summary (zh): ${input.summaryZh}`);
  if (input.content) parts.push(`Content: ${input.content}`);
  if (input.sourceUrls && input.sourceUrls.length > 0) {
    parts.push(`Known source URLs: ${input.sourceUrls.join(', ')}`);
  }
  parts.push(
    'Fields: kb_title (concise zh title), summary_zh (durable zh summary), ' +
      'tags (string[]), entities (string[]), source_urls (string[]), ' +
      'event_date (YYYY-MM-DD), long_term_value (integer 0-100, long-term reference value).',
  );
  return parts.join('\n');
}

/**
 * 对一条高价值候选事件产出经 Zod 校验的入库元数据。
 *
 * 成功：返回经 kbIngestionMetadataSchema 校验通过的对象（`long_term_value` 已保证 ∈ [0,100] 整数）。
 * 失败：所有尝试都因调用抛错或 Zod 校验不过（含 long_term_value 越界）而失败 → 记日志 + 抛
 *       KbIngestionAgentFailureError（降级信号），由调用方跳过该条、不入库。绝不返回未校验数据。
 */
export async function generateKbMetadata(
  input: KbIngestionInput,
  options: KbIngestionAgentOptions = {},
): Promise<KbIngestionMetadata> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[kb-ingestion-agent] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({
        model,
        schema: kbIngestionMetadataSchema,
        prompt,
      });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次（与 value-judge 同口径），确保
      // 未校验数据 / long_term_value 越界绝不外泄、绝不绕过准入闸。
      const parsed = kbIngestionMetadataSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：输出未通过 Zod 校验（含 long_term_value 越界检查）`,
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

  // 有限重试耗尽 → 降级（抛出），由调用方决定跳过该条不入库。绝不静默吞掉。
  throw new KbIngestionAgentFailureError(
    `知识摘要 Agent 在 ${maxAttempts} 次尝试后仍无法产出经校验的入库元数据，已降级（跳过该条、不入库）。`,
    maxAttempts,
    lastError,
  );
}
