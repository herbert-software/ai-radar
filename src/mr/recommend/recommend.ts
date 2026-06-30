/**
 * 编程订阅选型推荐器核心（add-model-radar-recommender 组 B，design D1/D3/D4；纯函数、可单测、不连 DB）。
 *
 * 召回经 vetted money-path（`queryModelRadarSnapshot`，**不手搓过滤/排序/cheapest**），撞窗经 snapshot 层
 * `fitsWindow`（纯数值原语）。快照作入参注入。MCP 单工具（组 C）调本函数。
 *
 * 关键不变量：
 * - **`currency` 与 `maxMonthlyPrice` 绝不喂 query**（`query.ts` 传 currency 排除所有未核价、传 budget 排除超预算 →
 *   `insufficient_data`/`not_recommended` 候选召回前消失）。二者是推荐器内的**判级**维度。
 * - **锁币种组（FX 红线）**：候选集 = 请求 currency(默认 CNY)已知价组 ∪ `sortScope.currency=null` 未知价组；
 *   **他币种已知价 plan 一律剔除**（绝不用裸数值跨币比 `currentPrice`），计数附「另有 N 个他币种未比」。
 * - **四态有序全覆盖 verdict**（每候选恰一态、按序短路）；空结果（primary=null）按落选缘由组合各诚实返、不空手。
 * - 撞窗是 **⚠ 估算**、口径未知如实标，绝不伪造。
 */
import { mrCategorySchema, mrCurrencySchema } from '../../db/mr-schema.zod.js';
import { DEFAULT_TOKENS_PER_ROUND, fitsWindow, type FitsWindow } from '../snapshot/limits.js';
import { modelRadarQueryParamsSchema, queryModelRadarSnapshot } from '../snapshot/query.js';
import type { ModelRadarSnapshot, SnapshotPlan, SnapshotPlanGroup } from '../snapshot/dto.js';
import { renderTemplate } from './explain.js';
import {
  recommendationResultSchema,
  type Explainer,
  type MrCurrency,
  type RankedCandidate,
  type RecommendQuery,
  type RecommendationResult,
  type RuleReason,
  type UsageProfile,
  type Verdict,
} from './schema.js';

/** 桶2 gate category + 默认币种——复用枚举 SOT（不依赖 web 层、不新立裸字面量）。 */
const RECOMMEND_CATEGORY = mrCategorySchema.enum.coding_plan;
const DEFAULT_CURRENCY: MrCurrency = mrCurrencySchema.enum.CNY;
const DEFAULT_USAGE: UsageProfile = 'medium';

/** usageProfile → 两个正交旋钮（recommender 自持；demandedRounds 与 tokensPerRound 互不耦合）。 */
const USAGE_KNOBS: Record<UsageProfile, { demandedRounds: number; tokensPerRound: number }> = {
  light: { demandedRounds: 50, tokensPerRound: DEFAULT_TOKENS_PER_ROUND },
  medium: { demandedRounds: 150, tokensPerRound: DEFAULT_TOKENS_PER_ROUND },
  heavy: { demandedRounds: 300, tokensPerRound: DEFAULT_TOKENS_PER_ROUND },
};

const BILLING_PERIOD_LABEL = {
  quarterly: '季付',
  annual: '年付',
} as const;

const BILLING_PERIOD_LOCK_MONTHS = {
  quarterly: 3,
  annual: 12,
} as const;

export interface RecommendInput {
  model?: string;
  tool?: string;
  protocol?: string;
  currency?: MrCurrency;
  maxMonthlyPrice?: number;
  usageProfile?: UsageProfile;
}

/** 只向 query 注入 `{category, model?, tool?, protocol?}`——currency/budget 绝不喂。 */
function recall(snapshot: ModelRadarSnapshot, input: Pick<RecommendInput, 'model' | 'tool' | 'protocol'>): SnapshotPlanGroup[] {
  const raw: Record<string, string> = { category: RECOMMEND_CATEGORY };
  if (input.model) raw.model = input.model;
  if (input.tool) raw.tool = input.tool;
  if (input.protocol) raw.protocol = input.protocol;
  return queryModelRadarSnapshot(snapshot, modelRadarQueryParamsSchema.parse(raw)).groups;
}

/** 锁币种组：取请求币种已知价组（已升序）+ null 未知价组；他币种已知价组计数（剔除）。 */
function selectCandidates(groups: SnapshotPlanGroup[], currency: MrCurrency): {
  knownPlans: SnapshotPlan[];
  unknownPlans: SnapshotPlan[];
  otherCurrencyCount: number;
} {
  const knownGroup = groups.find((g) => g.sortScope.currency === currency);
  const unknownGroup = groups.find((g) => g.sortScope.currency === null);
  const otherCurrencyCount = groups
    .filter((g) => g.sortScope.currency !== null && g.sortScope.currency !== currency)
    .reduce((n, g) => n + g.plans.length, 0);
  return {
    knownPlans: knownGroup ? knownGroup.plans : [],
    unknownPlans: unknownGroup ? unknownGroup.plans : [],
    otherCurrencyCount,
  };
}

function windowReason(fw: FitsWindow): RuleReason {
  if (fw === 'fits') return { kind: 'window', detail: '按用量档估算不撞额度窗（⚠ 估算）' };
  if (fw === 'exceeds') return { kind: 'window', detail: '按用量档估算会撞额度窗、额度不足（⚠ 估算）' };
  return { kind: 'window', detail: '额度口径未知、不保证不撞窗（⚠ 估算）' };
}

function formatMoney(n: number): string {
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function bestPeriodReason(plan: SnapshotPlan, preferredCurrency: MrCurrency): RuleReason | null {
  if (plan.category === 'token_plan') return null;

  const currency = plan.priceStatus === 'known' && plan.currency !== null ? plan.currency : preferredCurrency;
  const options: Array<{
    billingPeriod: 'monthly' | 'quarterly' | 'annual';
    effectiveMonthly: number;
    currency: MrCurrency;
  }> = [];

  if (plan.priceStatus === 'known' && plan.currentPrice !== null && plan.currency !== null) {
    options.push({
      billingPeriod: 'monthly',
      effectiveMonthly: Number(plan.currentPrice),
      currency: plan.currency,
    });
  }

  for (const pp of plan.periodPrices) {
    if (pp.priceStatus !== 'known' || pp.effectiveMonthly === null || pp.currency !== currency) continue;
    options.push({
      billingPeriod: pp.billingPeriod,
      effectiveMonthly: pp.effectiveMonthly,
      currency: pp.currency,
    });
  }

  if (options.length === 0) return null;

  const best = options.reduce((acc, option) => {
    if (option.effectiveMonthly < acc.effectiveMonthly) return option;
    if (option.effectiveMonthly === acc.effectiveMonthly && acc.billingPeriod !== 'monthly') return option;
    return acc;
  });

  if (best.billingPeriod === 'monthly') {
    return {
      kind: 'best_period',
      detail: `最佳周期=月付，有效月价 ${formatMoney(best.effectiveMonthly)} ${best.currency}`,
    };
  }

  return {
    kind: 'best_period',
    detail:
      `最佳周期=${BILLING_PERIOD_LABEL[best.billingPeriod]}，有效月价 ` +
      `${formatMoney(best.effectiveMonthly)} ${best.currency}（含预付锁期 ${BILLING_PERIOD_LOCK_MONTHS[best.billingPeriod]} 个月）`,
  };
}

type BaseVerdict = 'insufficient_data' | 'not_recommended' | 'eligible';

/** 单候选判级（有序短路）+ 规则原因；不分配 primary/alternative（那需全局最低价信息）。 */
function classify(
  plan: SnapshotPlan,
  input: RecommendInput,
  currency: MrCurrency,
  knobs: { demandedRounds: number; tokensPerRound: number },
): { fw: FitsWindow; base: BaseVerdict; reasons: RuleReason[] } {
  const reasons: RuleReason[] = [];
  if (input.model) reasons.push({ kind: 'model_match', detail: `含目标模型 ${input.model} ✓` });
  if (input.tool) reasons.push({ kind: 'tool_match', detail: `支持工具 ${input.tool} ✓` });
  if (input.protocol) reasons.push({ kind: 'protocol_match', detail: `支持协议 ${input.protocol} ✓` });

  // ⓪ 明确停售 → not_recommended，优先于未核价、待复核、超预算、撞窗。
  const fw = fitsWindow(plan.limits, knobs.demandedRounds, knobs.tokensPerRound);
  if (plan.availability === 'discontinued') {
    reasons.push({ kind: 'discontinued', detail: '已停售，不作推荐' });
    return { fw, base: 'not_recommended', reasons };
  }

  reasons.push(windowReason(fw));

  const bestPeriod = bestPeriodReason(plan, currency);
  if (bestPeriod) reasons.push(bestPeriod);

  // ① 未核价 或 待复核 → insufficient_data。
  const known = plan.priceStatus === 'known';
  if (!known || plan.reviewStatus.pending) {
    if (!known) reasons.push({ kind: 'unreviewed', detail: '价格未核（priceStatus≠known），不参与「最便宜」首选' });
    if (plan.reviewStatus.pending) {
      reasons.push({ kind: 'pending_review', detail: '存在待复核标记，需人工确认，不作首选' });
    }
    return { fw, base: 'insufficient_data', reasons };
  }

  // ② 已核 + (超预算 同币种内 ∨ exceeds) → not_recommended。
  // 防御（money-path fail-closed）：已标 known 但缺价/币种（快照不完整）→ 按未核处理，
  // 绝不让 Number(null)===0 造出免费幻影候选。
  if (plan.currentPrice === null || plan.currency === null) {
    reasons.push({ kind: 'unreviewed', detail: '已标已核但缺价/币种（快照不完整），按未核处理' });
    return { fw, base: 'insufficient_data', reasons };
  }
  const price = Number(plan.currentPrice);
  reasons.push({ kind: 'monthly_cost', detail: `月成本 ${price} ${plan.currency}` });
  const overBudget = input.maxMonthlyPrice !== undefined && price > input.maxMonthlyPrice;
  if (overBudget) {
    reasons.push({
      kind: 'over_budget',
      detail: `月成本 ${price} 超预算 ${input.maxMonthlyPrice}（同币种 ${plan.currency} 内）`,
    });
  }
  if (overBudget || fw === 'exceeds') return { fw, base: 'not_recommended', reasons };

  // ③/④ eligible（primary/alternative 在主函数按升序分配）。
  return { fw, base: 'eligible', reasons };
}

function toCandidate(plan: SnapshotPlan, fw: FitsWindow, verdict: Verdict, reasons: RuleReason[]): RankedCandidate {
  const known = plan.priceStatus === 'known';
  return {
    planId: plan.id,
    vendorName: plan.vendorName,
    name: plan.name,
    monthlyCost: known && plan.currentPrice !== null ? Number(plan.currentPrice) : null,
    currency: known ? plan.currency : null,
    priceStatus: plan.priceStatus,
    availability: plan.availability,
    stale: plan.freshness.stale,
    fitsWindow: fw,
    verdict,
    reasons,
    provenance: plan.provenance,
  };
}

/** 空召回：按 tool→protocol→model 逐维二次 query（不放宽预算/currency）得「放宽 X 有 N 个」。 */
function relaxationHints(snapshot: ModelRadarSnapshot, input: RecommendInput, currency: MrCurrency): string[] {
  const dims: Array<{ key: 'tool' | 'protocol' | 'model'; label: string }> = [
    { key: 'tool', label: '工具(tool)' },
    { key: 'protocol', label: '协议(protocol)' },
    { key: 'model', label: '模型(model)' },
  ];
  const hints: string[] = [];
  for (const { key, label } of dims) {
    if (input[key] === undefined) continue;
    const dropped: Pick<RecommendInput, 'model' | 'tool' | 'protocol'> = {};
    if (key !== 'model' && input.model) dropped.model = input.model;
    if (key !== 'tool' && input.tool) dropped.tool = input.tool;
    if (key !== 'protocol' && input.protocol) dropped.protocol = input.protocol;
    const { knownPlans, unknownPlans, otherCurrencyCount } = selectCandidates(recall(snapshot, dropped), currency);
    const n = knownPlans.length + unknownPlans.length;
    if (n > 0) {
      hints.push(
        otherCurrencyCount > 0
          ? `放宽${label}后有 ${n} 个候选（另有 ${otherCurrencyCount} 个他币种，未比）`
          : `放宽${label}后有 ${n} 个候选`,
      );
    } else if (otherCurrencyCount > 0) {
      hints.push(`放宽${label}后有 ${otherCurrencyCount} 个他币种候选（不跨币比价）`);
    }
  }
  return hints;
}

/** 0 eligible 且有候选：据已召回候选的落选缘由组合给说明（覆盖任意混合、无空洞）。 */
function composeNoEligible(candidates: RankedCandidate[], currency: MrCurrency): string {
  const parts: string[] = ['暂无可用首选'];

  const pending = candidates.filter((c) => c.verdict === 'insufficient_data').length;
  const discontinued = candidates.filter((c) => c.availability === 'discontinued').length;
  if (discontinued > 0) parts.push(`${discontinued} 个候选已停售`);
  if (pending > 0) parts.push(`${pending} 个候选待核（价格未核或待复核），不作首选`);

  // 超预算且非 exceeds（放宽预算即可用）：取最低超预算价作建议阈、数值重核（非二次 query）。
  const budgetBlocked = candidates.filter(
    (c) =>
      c.verdict === 'not_recommended' &&
      c.fitsWindow !== 'exceeds' &&
      c.monthlyCost !== null &&
      c.reasons.some((r) => r.kind === 'over_budget'),
  );
  if (budgetBlocked.length > 0) {
    const minPrice = Math.min(...budgetBlocked.map((c) => c.monthlyCost as number));
    const n = budgetBlocked.filter((c) => (c.monthlyCost as number) <= minPrice).length;
    parts.push(`放宽预算到 ${minPrice} ${currency} 有 ${n} 个可用`);
  }

  // exceeds（额度不足）：建议降用量档，不误导为放宽预算。
  const exceedsBlocked = candidates.filter(
    (c) => c.verdict === 'not_recommended' && c.fitsWindow === 'exceeds' && c.availability !== 'discontinued',
  ).length;
  if (exceedsBlocked > 0) parts.push(`${exceedsBlocked} 个候选额度不足（撞窗 exceeds），建议降低用量档`);

  return parts.join('；') + '。';
}

/**
 * 推荐主函数。`explain` 可插拔（v1 默认模板解释层）。返回经 Zod 校验的结构化结果。
 */
export async function recommend(
  snapshot: ModelRadarSnapshot,
  input: RecommendInput,
  explain: Explainer = renderTemplate,
): Promise<RecommendationResult> {
  const currency = input.currency ?? DEFAULT_CURRENCY;
  const usageProfile = input.usageProfile ?? DEFAULT_USAGE;
  const knobs = USAGE_KNOBS[usageProfile];

  const { knownPlans, unknownPlans, otherCurrencyCount } = selectCandidates(recall(snapshot, input), currency);
  const ordered = [...knownPlans, ...unknownPlans]; // 已核组已升序、未知组随后（未知永不 eligible）。

  // 判级 + 按升序首个 eligible 取 primary（不另手搓排序；裸 cheapest 被淘汰则自然顺延次低）。
  let primaryAssigned = false;
  const candidates: RankedCandidate[] = ordered.map((plan) => {
    const { fw, base, reasons } = classify(plan, input, currency, knobs);
    let verdict: Verdict;
    if (base === 'eligible') {
      if (!primaryAssigned) {
        primaryAssigned = true;
        verdict = 'primary';
        reasons.push({ kind: 'primary_cheapest', detail: '同币种内已核可用且最便宜（未撞窗 exceeds）→ 首选' });
      } else {
        verdict = 'alternative';
        reasons.push({ kind: 'alternative', detail: '同币种内已核可用、非最低价 → 备选' });
      }
    } else {
      verdict = base;
    }
    return toCandidate(plan, fw, verdict, reasons);
  });

  const query: RecommendQuery = {
    ...(input.model ? { model: input.model } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.protocol ? { protocol: input.protocol } : {}),
    currency,
    ...(input.maxMonthlyPrice !== undefined ? { maxMonthlyPrice: input.maxMonthlyPrice } : {}),
    usageProfile,
  };

  // 空结果按落选缘由组合（皆不空手）。
  let guidance = '';
  const totalRecalled = ordered.length + otherCurrencyCount;
  if (totalRecalled === 0) {
    const hints = relaxationHints(snapshot, input, currency);
    guidance = hints.length
      ? `未找到同时满足条件的候选。${hints.join('；')}。`
      : '未找到匹配候选；放宽 model/tool/protocol 维度后仍无候选。';
  } else {
    if (ordered.length === 0) {
      guidance = `未找到 ${currency} 币种候选（不跨币比价）。`;
    } else if (!primaryAssigned) {
      guidance = composeNoEligible(candidates, currency);
    }
    if (otherCurrencyCount > 0) {
      guidance = `${guidance ? `${guidance} ` : ''}另有 ${otherCurrencyCount} 个他币种 plan 未参与比较（不跨币比价）。`;
    }
  }

  const narration = await explain({ query, candidates });
  const explanation = [guidance, narration].map((s) => s.trim()).filter(Boolean).join('\n\n');

  return recommendationResultSchema.parse({ query, candidates, explanation });
}
