/**
 * 语义去重第四层：LLM 二次判断灰区同事件（add-semantic-dedup-and-store-hardening，组 D 任务 4.3，
 * spec「LLM 二次判断灰区同事件」/ design D6）。
 *
 * 职责：对落在灰区 (SEMANTIC_DEDUP_LLM, SEMANTIC_DEDUP_HIGH] 的候选对调用 LLM（Vercel AI SDK
 * `generateObject`），输出经 Zod 校验的结构化 JSON `{ same_event, same_product, reason }`（QA §9.2
 * 第四层），带重试 + 错误日志。
 *
 * 关键不变量（绝不可违背，spec / design D6）：
 * - **降级 = 不合并**（保守）：LLM 调用失败 / Zod 校验不过 / 重试耗尽 → 视为**不同事件**（不合并），
 *   记错误日志、不中止整批——欠合并（最多重复一条）安全，过合并会丢失独立事件（危险方向）。
 *   故本函数**绝不抛断**：失败返回 `{ same_event: false, ... degraded: true }`。
 * - 是否合并的**最终落库决定由程序据 `same_event` 执行**（见 merge-events / semantic-merge），
 *   LLM 仅产语义建议，绝不由 LLM 直接改写去重身份或唯一约束。
 * - **`same_product` 本期仅采集留存、不消费**：与 QA §9.2 JSON 形对齐、为后续产品语义合并预留，
 *   **绝不**据此触发任何 ai_products 合并或改写（产品语义合并是本期非目标）。
 *
 * 依赖注入：`generateObject` 经 `generateObjectFn` 选项注入（默认真实 SDK，照 value-judge 范式）；
 * 测试注入桩不触网（VITEST 守卫在 llm-client.defaultGenerateObject 兜底）。
 */
import { z } from 'zod';
import { buildModel, defaultGenerateObject } from '../agents/llm-client.js';

/**
 * LLM 二次判断输出 schema（QA §9.2 第四层）。
 * - same_event：两事件是否为同一现实事件（**程序据此决定是否合并**）。
 * - same_product：是否同一产品（本期**仅采集、不消费**——绝不接到 ai_products 合并）。
 * - reason：判断理由（自然语言，记入合并 provenance）。
 */
export const semanticJudgeOutputSchema = z.object({
  same_event: z.boolean(),
  same_product: z.boolean(),
  reason: z.string().min(1),
});

/** 经校验的 LLM 二次判断输出。 */
export type SemanticJudgeOutput = z.infer<typeof semanticJudgeOutputSchema>;

/**
 * `generateObject` 的最小依赖契约（仅取本模块用到的形参/返回）。注入此类型使测试可 mock，不触网。
 */
export type GenerateObjectFn = (args: {
  model: ReturnType<typeof buildModel>;
  schema: typeof semanticJudgeOutputSchema;
  prompt: string;
}) => Promise<{ object: unknown }>;

/** 待判候选对的两侧文本视图（构成 prompt）。 */
export interface JudgePairInput {
  /** 待判事件代表标题。 */
  titleA: string;
  /** 待判事件代表 content 摘录（可空）。 */
  contentA?: string | null;
  /** 候选事件代表标题。 */
  titleB: string;
  /** 候选事件代表 content 摘录（可空）。 */
  contentB?: string | null;
}

export interface SemanticJudgeOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言（降级被记录、非静默）。 */
  logError?: (message: string, detail: unknown) => void;
}

/** 二次判断结果：经校验的输出 + 是否降级标记（供 provenance / 可观测）。 */
export interface SemanticJudgeResult {
  /** 程序据此决定是否合并（降级时恒 false）。 */
  sameEvent: boolean;
  /** 同一产品建议（本期仅采集、不消费）。降级时恒 false。 */
  sameProduct: boolean;
  /** LLM 判断理由（降级时为降级说明）。 */
  reason: string;
  /** true = LLM 失败/校验不过被降级为「不合并」（非真实 LLM 判定）。 */
  degraded: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function buildPrompt(input: JudgePairInput): string {
  const parts = [
    'You are an AI-industry news deduplication judge. Decide whether the two items below describe the SAME real-world event (same announcement/release/incident), and whether they are about the SAME product. Return structured JSON.',
    '--- Item A ---',
    `Title: ${input.titleA}`,
  ];
  if (input.contentA) parts.push(`Content: ${input.contentA}`);
  parts.push('--- Item B ---', `Title: ${input.titleB}`);
  if (input.contentB) parts.push(`Content: ${input.contentB}`);
  parts.push(
    'Fields: same_event (boolean), same_product (boolean), reason (short string). ' +
      'same_event=true only if they report the same concrete event, not merely the same topic/company.',
  );
  return parts.join('\n');
}

/**
 * 对一个灰区候选对调用 LLM 二次判断（带重试 + Zod 校验）。
 *
 * 成功：返回 `{ sameEvent, sameProduct, reason, degraded: false }`。
 * 失败（调用抛错 / Zod 校验不过 / 重试耗尽）：**降级为不合并**——返回
 * `{ sameEvent: false, sameProduct: false, reason: '<降级说明>', degraded: true }`，
 * 记错误日志，**绝不抛断**（欠合并安全，spec「LLM 调用失败降级为不合并」）。
 */
export async function judgeSameEvent(
  input: JudgePairInput,
  options: SemanticJudgeOptions = {},
): Promise<SemanticJudgeResult> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[semantic-judge] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({ model, schema: semanticJudgeOutputSchema, prompt });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保未校验数据绝不被消费。
      const parsed = semanticJudgeOutputSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(`第 ${attempt}/${maxAttempts} 次：输出未通过 Zod 校验`, parsed.error.issues);
        continue;
      }
      return {
        sameEvent: parsed.data.same_event,
        sameProduct: parsed.data.same_product,
        reason: parsed.data.reason,
        degraded: false,
      };
    } catch (error) {
      lastError = error;
      logError(`第 ${attempt}/${maxAttempts} 次：generateObject 调用失败`, error);
    }
  }

  // 重试耗尽 → 降级为不合并（保守、欠合并安全），记日志，绝不抛断。
  logError(
    `LLM 二次判断在 ${maxAttempts} 次尝试后仍失败，降级为「不合并」（保留二者独立）`,
    lastError,
  );
  return {
    sameEvent: false,
    sameProduct: false,
    reason: `LLM 二次判断降级（${maxAttempts} 次尝试失败）→ 不合并`,
    degraded: true,
  };
}
