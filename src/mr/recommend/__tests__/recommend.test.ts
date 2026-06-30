/**
 * 推荐器核心纯单测（add-model-radar-recommender 组 B，task 4.3–4.6，**无 DB**，design D1/D3/D4）。
 *
 * 全部注入合成 in-memory 快照（非 seed 真价、不触 DB/Redis/飞书/Telegram）。覆盖：
 * - 4.3 召回：按 model/tool 召回、currency/budget **不喂 query**（未核→insufficient_data、超预算→not_recommended）；
 *        锁币种组（他币种已知价剔除、计数）；空结果按缘由（空召回放宽 tool/protocol/model、0-eligible 组合）；
 * - 4.4 verdict 四态有序全覆盖（每候选恰一态）：pending→insufficient、超预算/exceeds→not_recommended、
 *        eligible 最低→primary（裸 cheapest 被淘汰顺延次低）、其余→alternative、price==budget 含界 eligible；
 * - 4.5 撞窗：现数据 value:NULL → unknown「不保证不撞窗」不假装；monthly_tokens 非 NULL → fits/exceeds；
 * - 4.6 输出/模板：结果经 Zod 校验（四态 verdict、monthlyCost/currency 可空、含 stale）；模板话术含 reasons +
 *        provenance + 撞窗结论、无 LLM（确定性离线）；解释层 `ExplanationInput→Promise` 可插拔（注入替身验缝）。
 */
import { describe, expect, it, vi } from 'vitest';
import { recommend, type RecommendInput } from '../recommend.js';
import { recommendationResultSchema, type ExplanationInput } from '../schema.js';
import type { ModelRadarSnapshot, SnapshotLimit, SnapshotPeriodPrice, SnapshotPlan } from '../../snapshot/dto.js';
import type { MrCurrency } from '../schema.js';

const PROV = {
  sourceUrl: 'https://example.com/pricing',
  sourceConfidence: 'official_pricing' as const,
  lastCheckedDate: '2026-06-20',
};
const PROV_UNVETTED = { ...PROV, sourceConfidence: 'needs_login_recheck' as const };

function mkLimit(limitType: SnapshotLimit['limitType'], value: string | null, window = 'monthly'): SnapshotLimit {
  return { limitType, value, window, provenance: PROV };
}

interface PlanOpts {
  price?: string | null;
  currency?: MrCurrency | null;
  priceStatus?: 'known' | 'unknown';
  pending?: boolean;
  stale?: boolean;
  model?: { family: string; version: string };
  tool?: string;
  protocol?: string;
  limits?: SnapshotLimit[];
  availability?: SnapshotPlan['availability'];
  periodPrices?: SnapshotPeriodPrice[];
}

/** 默认匹配 model=glm:4.6 + tool=claude-code（recall 命中），可逐项覆盖。 */
function mkPlan(id: string, opts: PlanOpts = {}): SnapshotPlan {
  const known = (opts.priceStatus ?? 'known') === 'known';
  const model = opts.model ?? { family: 'glm', version: '4.6' };
  const tool = opts.tool ?? 'claude-code';
  return {
    id,
    vendorId: `vendor-${id}`,
    vendorName: `Vendor ${id}`,
    name: id,
    category: 'coding_plan',
    availability: opts.availability ?? 'unknown',
    currentPrice: known ? (opts.price ?? '49') : (opts.price ?? null),
    currency: known ? (opts.currency ?? 'CNY') : (opts.currency ?? null),
    priceStatus: known ? 'known' : 'unknown',
    provenance: known ? PROV : PROV_UNVETTED,
    freshness: { stale: opts.stale ?? false },
    reviewStatus: { pending: opts.pending ?? false },
    periodPrices: opts.periodPrices ?? [],
    models: [{ modelId: `m-${id}`, family: model.family, version: model.version, provenance: PROV }],
    clients: [
      { clientType: 'tool', clientId: tool, provenance: PROV },
      ...(opts.protocol ? [{ clientType: 'protocol' as const, clientId: opts.protocol, provenance: PROV }] : []),
    ],
    limits: opts.limits ?? [],
    sources: [],
  };
}

function mkPeriodPrice(opts: {
  billingPeriod?: SnapshotPeriodPrice['billingPeriod'];
  price?: string | null;
  currency?: MrCurrency;
  priceStatus?: 'known' | 'unknown';
  effectiveMonthly?: number | null;
} = {}): SnapshotPeriodPrice {
  const known = (opts.priceStatus ?? 'known') === 'known';
  const price = known ? (opts.price ?? '468') : (opts.price ?? null);
  return {
    billingPeriod: opts.billingPeriod ?? 'annual',
    price,
    currency: opts.currency ?? 'CNY',
    priceStatus: known ? 'known' : 'unknown',
    provenance: known ? PROV : PROV_UNVETTED,
    effectiveMonthly: known ? (opts.effectiveMonthly ?? 39) : null,
  };
}

function snap(...plans: SnapshotPlan[]): ModelRadarSnapshot {
  return { plans };
}

/** monthly_tokens 撞窗刻度（heavy demanded=300 @ 15k/轮）：fits 需 total≥6.75M、exceeds 需 total≤2.25M。 */
const TOKENS_FITS = mkLimit('monthly_tokens', '10000000');
const TOKENS_EXCEEDS = mkLimit('monthly_tokens', '1000000');
const heavy: RecommendInput['usageProfile'] = 'heavy';

describe('4.3 规则硬筛召回：currency/budget 不喂 query、锁币种组、空结果按缘由', () => {
  it('按 model+tool 召回；未核价候选被召回标 insufficient_data、超预算候选被召回标 not_recommended', async () => {
    const s = snap(
      mkPlan('elig', { price: '49' }),
      mkPlan('unvetted', { priceStatus: 'unknown' }), // 未核 → 不会被 currency 喂 query 排除
      mkPlan('pricey', { price: '500' }), // 超预算 → 不会被 budget 喂 query 排除
    );
    const r = await recommend(s, { model: 'glm:4.6', tool: 'claude-code', currency: 'CNY', maxMonthlyPrice: 100 });
    const byId = new Map(r.candidates.map((c) => [c.planId, c]));
    expect(r.candidates).toHaveLength(3); // 三者全召回（currency/budget 未喂 query）
    expect(byId.get('unvetted')!.verdict).toBe('insufficient_data');
    expect(byId.get('unvetted')!.monthlyCost).toBeNull();
    expect(byId.get('pricey')!.verdict).toBe('not_recommended');
    expect(byId.get('elig')!.verdict).toBe('primary');
  });

  it('锁币种组：他币种已知价 plan 被剔除（不跨币比预算），计数附「另有 N 个他币种」', async () => {
    const s = snap(
      mkPlan('cny', { price: '49', currency: 'CNY' }),
      mkPlan('usd', { price: '5', currency: 'USD' }), // 他币种已知价 → 剔除、不与 CNY 预算比
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY', maxMonthlyPrice: 100 });
    expect(r.candidates.map((c) => c.planId)).toEqual(['cny']); // usd 不在候选集
    expect(r.explanation).toContain('他币种');
  });

  it('空召回（无 plan 含目标 tool）→ 放宽 tool/protocol/model 维度二次 query 提示', async () => {
    const s = snap(mkPlan('p', { tool: 'cursor' })); // 只有 cursor、无 claude-code
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY' });
    expect(r.candidates).toHaveLength(0);
    expect(r.explanation).toContain('放宽');
  });

  it('空召回但放宽维度 surface 他币种候选 → relaxation 路径如实披露「他币种」（FIX 4 跨币视差）', async () => {
    // 唯一 plan 是 USD claude-code；请求 tool=cursor（无匹配 → 空召回），放宽 tool 后该 USD plan 浮现。
    // selectCandidates 锁 CNY → 它落他币种组（otherCurrencyCount=1），relaxationHints 须如实披露「他币种」。
    const s = snap(mkPlan('usd-cc', { tool: 'claude-code', currency: 'USD', price: '5' }));
    const r = await recommend(s, { tool: 'cursor', currency: 'CNY' });
    expect(r.candidates).toHaveLength(0); // 空召回（无 cursor plan）
    expect(r.explanation).toContain('放宽');
    expect(r.explanation).toContain('他币种'); // 放宽 tool 后浮现的 USD plan 经 relaxation 路径披露（与主路径同口径）
  });

  it('0-eligible 且有候选：据待核 / 超预算 / exceeds 缘由组合给说明（不空手、不误导）', async () => {
    const s = snap(
      mkPlan('disc', { price: '20', availability: 'discontinued' }), // 已停售
      mkPlan('pend', { price: '30', pending: true }), // 待核
      mkPlan('over', { price: '500' }), // 超预算（放宽预算可用）
      mkPlan('big', { price: '40', limits: [TOKENS_EXCEEDS] }), // exceeds（降用量档）
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY', maxMonthlyPrice: 100, usageProfile: heavy });
    expect(r.candidates.some((c) => c.verdict === 'primary')).toBe(false); // primary=null
    expect(r.explanation).toContain('已停售');
    expect(r.explanation).toContain('待核');
    expect(r.explanation).toContain('放宽预算到 500 CNY');
    expect(r.explanation).toContain('降低用量档'); // exceeds 不误导为放宽预算
  });
});

describe('4.4 verdict 四态有序全覆盖（每候选恰一态、无重叠无空洞）', () => {
  it('discontinued→not_recommended，且优先于未核价 / pending / exceeds / 最佳周期', async () => {
    const s = snap(
      mkPlan('disc', {
        availability: 'discontinued',
        priceStatus: 'unknown',
        pending: true,
        limits: [TOKENS_EXCEEDS],
        periodPrices: [mkPeriodPrice({ price: '468', effectiveMonthly: 39 })],
      }),
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY', usageProfile: heavy });
    const disc = r.candidates[0]!;
    expect(disc.verdict).toBe('not_recommended');
    expect(disc.availability).toBe('discontinued');
    expect(disc.fitsWindow).toBe('exceeds'); // 字段仍计算，但不作为停售候选的 reason 主因
    expect(disc.reasons.some((reason) => reason.kind === 'discontinued' && reason.detail.includes('已停售'))).toBe(true);
    expect(disc.reasons.some((reason) => reason.kind === 'window')).toBe(false);
    expect(disc.reasons.some((reason) => reason.kind === 'best_period')).toBe(false);
    expect(disc.reasons.some((reason) => reason.kind === 'unreviewed')).toBe(false);
    expect(disc.reasons.some((reason) => reason.kind === 'pending_review')).toBe(false);
    expect(r.explanation).toContain('已停售');
    expect(r.explanation).not.toContain('降低用量档');
    expect(r.explanation).not.toContain('额度不足');
    expect(r.explanation).not.toContain('含可能已停售');
    expect(r.explanation).not.toContain('含停售占位');
  });

  it('pending→insufficient、超预算/exceeds→not_recommended、最低 eligible→primary、其余→alternative', async () => {
    const s = snap(
      mkPlan('p30pending', { price: '30', pending: true }), // 已核+pending → insufficient_data
      mkPlan('p40exceeds', { price: '40', limits: [TOKENS_EXCEEDS] }), // 已核+exceeds → not_recommended
      mkPlan('p60', { price: '60' }), // eligible（最低 eligible）→ primary
      mkPlan('p90', { price: '90' }), // eligible → alternative
      mkPlan('p500', { price: '500' }), // 超预算 → not_recommended
      mkPlan('punknown', { priceStatus: 'unknown' }), // 未核 → insufficient_data
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY', maxMonthlyPrice: 100, usageProfile: heavy });
    const v = Object.fromEntries(r.candidates.map((c) => [c.planId, c.verdict]));
    expect(v.p30pending).toBe('insufficient_data');
    expect(v.punknown).toBe('insufficient_data');
    expect(v.p40exceeds).toBe('not_recommended');
    expect(v.p500).toBe('not_recommended');
    expect(v.p60).toBe('primary'); // 裸 cheapest（p40）被 exceeds 淘汰 → 顺延次低 eligible
    expect(v.p90).toBe('alternative');
    // 每候选恰一态：四态计数全覆盖。
    const counts = { insufficient_data: 0, not_recommended: 0, primary: 0, alternative: 0 };
    for (const c of r.candidates) counts[c.verdict]++;
    expect(counts).toEqual({ insufficient_data: 2, not_recommended: 2, primary: 1, alternative: 1 });
  });

  it('price == budget 含界 eligible（> 严格、等于不算超预算）', async () => {
    const s = snap(mkPlan('exact', { price: '100' }));
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY', maxMonthlyPrice: 100 });
    expect(r.candidates[0]!.verdict).toBe('primary'); // 100 == 100 → 不超预算 → eligible
  });
});

describe('4.4/5d 最佳周期标注（不改 canonical 月价排名）', () => {
  it('已核季/年有效月价低于月价时标最佳周期，排名仍按 canonical 月价', async () => {
    const s = snap(
      mkPlan('monthly45', { price: '45' }),
      mkPlan('annual49', { price: '49', periodPrices: [mkPeriodPrice({ price: '468', effectiveMonthly: 39 })] }),
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY' });

    expect(r.candidates.map((c) => [c.planId, c.verdict])).toEqual([
      ['monthly45', 'primary'],
      ['annual49', 'alternative'],
    ]);
    const annual = r.candidates.find((c) => c.planId === 'annual49')!;
    const bestPeriod = annual.reasons.find((reason) => reason.kind === 'best_period');
    expect(bestPeriod?.detail).toContain('最佳周期=年付');
    expect(bestPeriod?.detail).toContain('有效月价 39 CNY');
    expect(bestPeriod?.detail).toContain('含预付锁期');
    expect(r.explanation).toContain('最佳周期=年付');
  });

  it('canonical 月价未核但同币种周期价已核时也可标最佳周期，verdict 仍按未核价规则', async () => {
    const s = snap(
      mkPlan('period-only', {
        priceStatus: 'unknown',
        periodPrices: [mkPeriodPrice({ price: '468', effectiveMonthly: 39 })],
      }),
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY' });
    const candidate = r.candidates[0]!;
    expect(candidate.verdict).toBe('insufficient_data');
    expect(candidate.monthlyCost).toBeNull();
    expect(candidate.reasons.find((reason) => reason.kind === 'best_period')?.detail).toContain('最佳周期=年付');
  });

  it('canonical 月价未核时不拿异币种周期价生成最佳周期', async () => {
    const s = snap(
      mkPlan('usd-period-only', {
        priceStatus: 'unknown',
        periodPrices: [mkPeriodPrice({ currency: 'USD', price: '60', effectiveMonthly: 5 })],
      }),
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY' });
    expect(r.candidates[0]!.reasons.some((reason) => reason.kind === 'best_period')).toBe(false);
  });
});

describe('4.5 撞窗判级（⚠ 估算、口径未知不假装）', () => {
  it('现数据桶2 全 value:NULL → 所有候选 unknown「不保证不撞窗」', async () => {
    const s = snap(
      mkPlan('bucket2', {
        price: '49',
        limits: [mkLimit('rolling_5h_requests', null), mkLimit('credit', null), mkLimit('fast_pass', null)],
      }),
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY', usageProfile: heavy });
    expect(r.candidates[0]!.fitsWindow).toBe('unknown');
    expect(r.candidates[0]!.verdict).toBe('primary'); // unknown 属 eligible（unknown≠exceeds）
    expect(r.explanation).toContain('额度口径未知');
  });

  it('monthly_tokens 非 NULL → fits / exceeds', async () => {
    const sFits = snap(mkPlan('fits', { price: '49', limits: [TOKENS_FITS] }));
    const sExceeds = snap(mkPlan('ex', { price: '49', limits: [TOKENS_EXCEEDS] }));
    const rFits = await recommend(sFits, { tool: 'claude-code', currency: 'CNY', usageProfile: heavy });
    const rExceeds = await recommend(sExceeds, { tool: 'claude-code', currency: 'CNY', usageProfile: heavy });
    expect(rFits.candidates[0]!.fitsWindow).toBe('fits');
    expect(rExceeds.candidates[0]!.fitsWindow).toBe('exceeds');
    expect(rExceeds.candidates[0]!.verdict).toBe('not_recommended'); // exceeds → not_recommended
  });
});

describe('4.6 输出 schema + 模板解释层', () => {
  it('结果经 Zod 校验：四态 verdict、monthlyCost/currency 可空、含 stale', async () => {
    const s = snap(
      mkPlan('known', { price: '49', stale: true }),
      mkPlan('unvetted', { priceStatus: 'unknown' }),
    );
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY' });
    expect(recommendationResultSchema.safeParse(r).success).toBe(true);
    const known = r.candidates.find((c) => c.planId === 'known')!;
    const unvetted = r.candidates.find((c) => c.planId === 'unvetted')!;
    expect(known.monthlyCost).toBe(49);
    expect(known.currency).toBe('CNY');
    expect(known.stale).toBe(true);
    expect(unvetted.monthlyCost).toBeNull(); // 未核为 null
    expect(unvetted.currency).toBeNull();
  });

  it('模板话术含 reasons + provenance + 撞窗结论，且无 LLM（确定性离线）', async () => {
    const s = snap(mkPlan('p', { price: '49', limits: [mkLimit('credit', null)] }));
    const r1 = await recommend(s, { model: 'glm:4.6', tool: 'claude-code', currency: 'CNY', usageProfile: heavy });
    const r2 = await recommend(s, { model: 'glm:4.6', tool: 'claude-code', currency: 'CNY', usageProfile: heavy });
    expect(r1.explanation).toBe(r2.explanation); // 确定性 → 无 LLM 随机
    expect(r1.explanation).toContain('glm:4.6'); // model 命中 reason
    expect(r1.explanation).toContain('claude-code'); // tool 命中 reason
    expect(r1.explanation).toContain('https://example.com/pricing'); // provenance
    expect(r1.explanation).toContain('额度口径未知'); // 撞窗结论（⚠ 估算）
  });

  it('解释层可插拔：注入替身 explainer 被推荐主函数采用（验缝）', async () => {
    const spy = vi.fn((_input: ExplanationInput) => Promise.resolve('INJECTED-EXPLANATION'));
    const s = snap(mkPlan('p', { price: '49' }));
    const r = await recommend(s, { tool: 'claude-code', currency: 'CNY' }, spy);
    expect(spy).toHaveBeenCalledOnce();
    expect(r.explanation).toBe('INJECTED-EXPLANATION'); // primary 存在、无 guidance → 直接用替身输出
  });
});
