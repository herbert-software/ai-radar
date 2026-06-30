/**
 * Model Radar 编程订阅选型推荐器（P5 / 5e，add-model-radar-recommender 组 B）**输出 schema + 解释层接口**。
 *
 * 纯 Zod 形状契约（无 DB、无 HTTP、无 LLM）——推荐主函数（./recommend.ts）填充、MCP 单工具（组 C）消费。
 * 关键不变量（design D3）：
 * - `candidates` 是**扁平数组**（每条带 `verdict`，**非** `{首选,备选,...}` 分桶）；全由规则 + DB 事实定。
 * - `verdict` 四态有序全覆盖（每候选恰一态）；`monthlyCost`/`currency` 未核为 null；`stale` 取自 plan `freshness.stale`。
 * - `reasons` 是结构化规则原因（模板 v1 与 RAG+LLM v2 **同消费**），**不**另设顶层 `ruleReasons`。
 * - 解释层接口 `ExplanationInput → Promise<explanation>`：v1 模板忽略 `query`/`evidence`，v2 经**同一接口**用 `evidence`
 *   （RAG 证据，类型 `unknown`、不预钉形状），召回与候选 schema 不变 —— 杜绝换层重构。
 */
import { z } from 'zod';
import { mrAvailabilitySchema, mrCurrencySchema } from '../../db/mr-schema.zod.js';
import { priceStatusSchema, snapshotProvenanceSchema } from '../snapshot/dto.js';

/** 用量档（轻/中/重）；推荐器自持其 → `{demandedRounds, tokensPerRound}` 映射（两个正交旋钮）。 */
export const usageProfileSchema = z.enum(['light', 'medium', 'heavy']);
export type UsageProfile = z.infer<typeof usageProfileSchema>;

/** 四态 verdict（有序全覆盖：insufficient_data > not_recommended > primary > alternative）。 */
export const verdictSchema = z.enum(['primary', 'alternative', 'not_recommended', 'insufficient_data']);
export type Verdict = z.infer<typeof verdictSchema>;

/** 撞窗结论（与 snapshot 层 `FitsWindow` 同值集；⚠ 估算、绝不进哈希/事实）。 */
export const fitsWindowSchema = z.enum(['fits', 'exceeds', 'unknown']);

/** 结构化规则原因 kind（模板 + v2 LLM 同消费；`detail` 是人读话术）。 */
export const ruleReasonKindSchema = z.enum([
  'model_match',
  'tool_match',
  'protocol_match',
  'monthly_cost',
  'window',
  'discontinued',
  'unreviewed',
  'pending_review',
  'over_budget',
  'best_period',
  'primary_cheapest',
  'alternative',
]);
export const ruleReasonSchema = z.object({
  kind: ruleReasonKindSchema,
  detail: z.string(),
});
export type RuleReason = z.infer<typeof ruleReasonSchema>;

/** 单条扁平候选（带 verdict）。`monthlyCost`/`currency` 未核为 null；`stale` 取 plan 级 `freshness.stale`。 */
export const rankedCandidateSchema = z.object({
  planId: z.string(),
  vendorName: z.string(),
  name: z.string(),
  monthlyCost: z.number().nullable(),
  currency: z.string().nullable(),
  priceStatus: priceStatusSchema,
  availability: mrAvailabilitySchema,
  stale: z.boolean(),
  fitsWindow: fitsWindowSchema,
  verdict: verdictSchema,
  reasons: z.array(ruleReasonSchema),
  provenance: snapshotProvenanceSchema,
});
export type RankedCandidate = z.infer<typeof rankedCandidateSchema>;

/** 推荐查询回显（已套默认：currency=CNY、usageProfile=medium；预算/model/tool/protocol 可选）。 */
export const recommendQuerySchema = z.object({
  model: z.string().optional(),
  tool: z.string().optional(),
  protocol: z.string().optional(),
  currency: mrCurrencySchema,
  maxMonthlyPrice: z.number().nonnegative().finite().optional(),
  usageProfile: usageProfileSchema,
});
export type RecommendQuery = z.infer<typeof recommendQuerySchema>;
export type MrCurrency = z.infer<typeof mrCurrencySchema>;

/** 推荐结果（结构化 + Zod 校验，design D3）。`candidates` 扁平；`explanation` 由可插拔解释层产出。 */
export const recommendationResultSchema = z.object({
  query: recommendQuerySchema,
  candidates: z.array(rankedCandidateSchema),
  explanation: z.string(),
});
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;

/**
 * 解释层入参（v1 模板忽略 `query`/`evidence`、纯从 `candidates` 渲染；v2 LLM 经同一接口用 `evidence`）。
 * 规则原因已在 `candidates[].reasons` 内、**不**另设顶层 `ruleReasons`；`evidence` 类型 `unknown`、不预钉 RAG 形状。
 */
export interface ExplanationInput {
  query: RecommendQuery;
  candidates: RankedCandidate[];
  evidence?: unknown;
}

/** 可插拔解释层签名（`ExplanationInput → Promise<explanation>`）。 */
export type Explainer = (input: ExplanationInput) => Promise<string>;
