/**
 * 过滤/排序服务单测（task 3.5）——**合成 in-memory 快照 fixture，非 seed 真价、不触 DB**。
 *
 * 覆盖 spec「比价检索 API 基于快照确定性过滤」「同桶价格排序必须按已核 provenance + 同币种判定」：
 * - 非官方 confidence 带价不成 cheapest（priceStatus=unknown 由 fixture 钉死，组 C 直接用不重算 provenance）；
 * - 未知价排已知价后（已知币种组在前、currency=null 未知组在后）；
 * - 混币按 (category, currency) 分组、不当同单位比；
 * - 全 unknown → currency=null 组、cheapest=null、comparable=false、unknownCount；
 * - 非法 query/model 语法（含裸 family）、未知参数、非法枚举、裸预算被 Zod 拒；
 * - currency × maxMonthlyPrice 币种不一致 → 拒；
 * - currency 过滤排除 currency=NULL / 未知价 plan；预算过滤排除未知价 + 异币种 + 超预算。
 */
import { describe, expect, it } from 'vitest';
import {
  modelRadarQueryParamsSchema,
  queryModelRadarSnapshot,
  type ModelRadarQueryParams,
} from '../query.js';
import { snapshotPlanSchema, snapshotProvenanceSchema, snapshotSourceSchema } from '../dto.js';
import type { ModelRadarSnapshot, SnapshotPlan } from '../dto.js';

/** 已核官方价 plan（priceStatus=known，满足 dto.superRefine）。 */
function known(
  id: string,
  price: string,
  currency: SnapshotPlan['currency'],
  category: SnapshotPlan['category'] = 'coding_plan',
): SnapshotPlan {
  return {
    id,
    vendorId: 'v1',
    vendorName: 'Vendor 1',
    name: id,
    category,
    availability: 'unknown',
    currentPrice: price,
    currency,
    priceStatus: 'known',
    provenance: {
      sourceUrl: 'https://example.com/pricing',
      sourceConfidence: 'official_pricing',
      lastCheckedDate: '2026-06-20',
    },
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [],
    clients: [],
    limits: [],
    sources: [],
  };
}

/** 未知价 plan：可为占位 NULL，或非官方 confidence 带价（如 40 CNY needs_login_recheck）。 */
function unknown(
  id: string,
  opts: {
    price?: string | null;
    currency?: SnapshotPlan['currency'] | null;
    category?: SnapshotPlan['category'];
  } = {},
): SnapshotPlan {
  return {
    id,
    vendorId: 'v1',
    vendorName: 'Vendor 1',
    name: id,
    category: opts.category ?? 'coding_plan',
    availability: 'unknown',
    currentPrice: opts.price ?? null,
    currency: opts.currency ?? null,
    priceStatus: 'unknown',
    provenance: {
      sourceUrl: 'https://example.com/x',
      sourceConfidence: 'needs_login_recheck',
      lastCheckedDate: '2026-06-20',
    },
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [],
    clients: [],
    limits: [],
    sources: [],
  };
}

function snap(...plans: SnapshotPlan[]): ModelRadarSnapshot {
  return { plans };
}

/** 解析空查询（全可选）→ 默认 params（requiresKnownPrice=false）。 */
const defaults: ModelRadarQueryParams = modelRadarQueryParamsSchema.parse({});

describe('3.5 过滤/排序服务（合成快照 fixture）', () => {
  it('非官方 confidence 带价不参与 cheapest（unknown 归 null 组）', () => {
    // A 已核 30 CNY；B 价更低 20 但 needs_login_recheck → priceStatus=unknown，不得冒充 cheapest。
    const s = snap(known('A', '30', 'CNY'), unknown('B', { price: '20', currency: 'CNY' }));
    const { groups } = queryModelRadarSnapshot(s, defaults);

    const cny = groups.find((g) => g.sortScope.currency === 'CNY')!;
    expect(cny.cheapestPlanId).toBe('A');
    expect(cny.plans.map((p) => p.id)).toEqual(['A']); // B 不在已知币种组

    const nullGroup = groups.find((g) => g.sortScope.currency === null)!;
    expect(nullGroup.plans.map((p) => p.id)).toEqual(['B']);
    expect(nullGroup.cheapestPlanId).toBeNull();
    expect(nullGroup.comparable).toBe(false);
    expect(nullGroup.unknownCount).toBe(1);
  });

  it('已知价升序 + 未知价排已知后（null 组末位）', () => {
    const s = snap(known('A', '40', 'CNY'), known('C', '10', 'CNY'), unknown('B'));
    const { groups } = queryModelRadarSnapshot(s, defaults);

    // 组序：已知币种组在前、null 组末位。
    expect(groups[0]!.sortScope.currency).toBe('CNY');
    expect(groups[groups.length - 1]!.sortScope.currency).toBeNull();

    const cny = groups[0]!;
    expect(cny.plans.map((p) => p.id)).toEqual(['C', 'A']); // 升序 10 < 40
    expect(cny.cheapestPlanId).toBe('C');

    const nullGroup = groups[groups.length - 1]!;
    expect(nullGroup.plans.map((p) => p.id)).toEqual(['B']);
    expect(nullGroup.cheapestPlanId).toBeNull();
  });

  it('混币不当同单位比：按 (category, currency) 分组', () => {
    const s = snap(known('C', '20', 'EUR'), known('D', '40', 'CNY'));
    const { groups } = queryModelRadarSnapshot(s, defaults);

    expect(groups).toHaveLength(2);
    const byCur = Object.fromEntries(groups.map((g) => [g.sortScope.currency, g]));
    expect(byCur.CNY!.cheapestPlanId).toBe('D');
    expect(byCur.EUR!.cheapestPlanId).toBe('C');
    // 无任一组同时含两币种 plan
    for (const g of groups) {
      const curs = new Set(g.plans.map((p) => p.currency));
      expect(curs.size).toBe(1);
    }
  });

  it('全 unknown → currency=null 组、cheapest=null、comparable=false', () => {
    const s = snap(unknown('A'), unknown('B', { price: '40', currency: 'CNY' }));
    const { groups } = queryModelRadarSnapshot(s, defaults);

    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.sortScope.currency).toBeNull();
    expect(g.cheapestPlanId).toBeNull();
    expect(g.comparable).toBe(false);
    expect(g.unknownCount).toBe(2);
    expect(g.plans.map((p) => p.id).sort()).toEqual(['A', 'B']);
  });

  it('requiresKnownPrice=true 排除未知价', () => {
    const s = snap(known('A', '30', 'CNY'), unknown('B'));
    const params = modelRadarQueryParamsSchema.parse({ requiresKnownPrice: 'true' });
    const { groups } = queryModelRadarSnapshot(s, params);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.plans.map((p) => p.id)).toEqual(['A']);
    expect(groups.some((g) => g.sortScope.currency === null)).toBe(false);
  });

  it('currency 过滤排除 currency=NULL / 未知价 / 异币种 plan', () => {
    const s = snap(
      known('A', '20', 'USD'),
      known('B', '40', 'CNY'), // 异币种
      unknown('C'), // currency=NULL 占位
      unknown('D', { price: '50', currency: 'USD' }), // currency 非 NULL 但 priceStatus=unknown
    );
    const params = modelRadarQueryParamsSchema.parse({ currency: 'USD' });
    const { groups } = queryModelRadarSnapshot(s, params);

    const ids = groups.flatMap((g) => g.plans.map((p) => p.id));
    expect(ids).toEqual(['A']); // 仅已核 USD；CNY/占位/未知价 USD 全排除
    expect(groups.every((g) => g.sortScope.currency === 'USD')).toBe(true);
  });

  it('预算过滤排除未知价 + 异币种 + 超预算', () => {
    const s = snap(
      known('A', '50', 'CNY'),
      known('B', '150', 'CNY'), // 超预算
      known('C', '50', 'USD'), // 异币种
      unknown('D', { price: '10', currency: 'CNY' }), // 未知价（不当 0/不入预算）
    );
    const params = modelRadarQueryParamsSchema.parse({ maxMonthlyPrice: '100 CNY' });
    const { groups } = queryModelRadarSnapshot(s, params);

    const ids = groups.flatMap((g) => g.plans.map((p) => p.id));
    expect(ids).toEqual(['A']);
  });

  it('discontinued 已核低价可列出但不成为 cheapest；unknown availability 不误杀', () => {
    const discontinued = known('A', '1', 'CNY');
    discontinued.availability = 'discontinued';
    const unknownAvailability = known('B', '49', 'CNY');
    unknownAvailability.availability = 'unknown';
    const s = snap(discontinued, unknownAvailability);
    const { groups } = queryModelRadarSnapshot(s, defaults);

    const cny = groups.find((g) => g.sortScope.currency === 'CNY')!;
    expect(cny.plans.map((p) => p.id)).toEqual(['A', 'B']);
    expect(cny.cheapestPlanId).toBe('B');
    expect(cny.comparable).toBe(true);
  });

  it('全 discontinued 已核价组仍列出但不可比、无 cheapest', () => {
    const a = known('A', '1', 'CNY');
    const b = known('B', '2', 'CNY');
    a.availability = 'discontinued';
    b.availability = 'discontinued';
    const { groups } = queryModelRadarSnapshot(snap(a, b), defaults);

    const cny = groups.find((g) => g.sortScope.currency === 'CNY')!;
    expect(cny.plans.map((p) => p.id)).toEqual(['A', 'B']);
    expect(cny.cheapestPlanId).toBeNull();
    expect(cny.comparable).toBe(false);
  });

  it('季/年 effectiveMonthly 不参与 cheapest，仍按 canonical 月价排序', () => {
    const annualCheaper = known('A', '49', 'CNY');
    annualCheaper.periodPrices = [
      {
        billingPeriod: 'annual',
        price: '468.00',
        currency: 'CNY',
        priceStatus: 'known',
        provenance: {
          sourceUrl: 'https://example.com/pricing',
          sourceConfidence: 'official_pricing',
          lastCheckedDate: '2026-06-20',
        },
        effectiveMonthly: 39,
      },
    ];
    const monthlyCheaper = known('B', '45', 'CNY');
    const { groups } = queryModelRadarSnapshot(snap(annualCheaper, monthlyCheaper), defaults);

    const cny = groups.find((g) => g.sortScope.currency === 'CNY')!;
    expect(cny.plans.map((p) => p.id)).toEqual(['B', 'A']);
    expect(cny.cheapestPlanId).toBe('B');
  });
});

describe('3.5 查询参数 Zod 闸（非法 → 拒，组 E 映射 400）', () => {
  it('裸 family 无冒号 → 拒', () => {
    expect(modelRadarQueryParamsSchema.safeParse({ model: 'glm' }).success).toBe(false);
  });

  it('空 family（:4.6 / 仅空白前缀）→ 拒', () => {
    expect(modelRadarQueryParamsSchema.safeParse({ model: ':4.6' }).success).toBe(false);
    expect(modelRadarQueryParamsSchema.safeParse({ model: '  :4.6' }).success).toBe(false);
  });

  it('合法 model 语法解析 family 小写 + version', () => {
    const r = modelRadarQueryParamsSchema.parse({ model: 'GLM:4.6' });
    expect(r.model).toEqual({ family: 'glm', version: '4.6' });
  });

  it('空版本 family: 匹配哨兵空串', () => {
    const r = modelRadarQueryParamsSchema.parse({ model: 'glm:' });
    expect(r.model).toEqual({ family: 'glm', version: '' });
  });

  it('未知参数 → 拒（strict）', () => {
    expect(modelRadarQueryParamsSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });

  it('非法 category 枚举 → 拒', () => {
    expect(modelRadarQueryParamsSchema.safeParse({ category: 'bogus' }).success).toBe(false);
  });

  it('裸预算无 currency → 拒', () => {
    expect(modelRadarQueryParamsSchema.safeParse({ maxMonthlyPrice: '100' }).success).toBe(false);
  });

  it('预算非法币种 → 拒；合法 "100 CNY" 解析', () => {
    expect(modelRadarQueryParamsSchema.safeParse({ maxMonthlyPrice: '100 GBP' }).success).toBe(false);
    const r = modelRadarQueryParamsSchema.parse({ maxMonthlyPrice: '100 CNY' });
    expect(r.maxMonthlyPrice).toEqual({ amount: 100, currency: 'CNY' });
  });

  it('currency × maxMonthlyPrice 币种不一致 → 拒；一致 → 通过', () => {
    expect(
      modelRadarQueryParamsSchema.safeParse({ currency: 'USD', maxMonthlyPrice: '100 CNY' }).success,
    ).toBe(false);
    expect(
      modelRadarQueryParamsSchema.safeParse({ currency: 'CNY', maxMonthlyPrice: '100 CNY' }).success,
    ).toBe(true);
  });

  it('tool/protocol clientId 精确大小写敏感过滤', () => {
    const planWithTool: SnapshotPlan = {
      ...known('A', '20', 'USD'),
      clients: [
        {
          clientType: 'tool',
          clientId: 'claude-code',
          provenance: {
            sourceUrl: 'https://x',
            sourceConfidence: 'official_doc',
            lastCheckedDate: '2026-06-20',
          },
        },
      ],
    };
    const s = snap(planWithTool);
    // 精确匹配命中
    expect(
      queryModelRadarSnapshot(s, modelRadarQueryParamsSchema.parse({ tool: 'claude-code' })).groups,
    ).toHaveLength(1);
    // 大小写不同 → 不命中
    expect(
      queryModelRadarSnapshot(s, modelRadarQueryParamsSchema.parse({ tool: 'Claude-Code' })).groups,
    ).toHaveLength(0);
  });
});

describe('5c review FIX CR6：读侧 sourceUrl 拒纯空白（对齐写侧 mrSourceUrlSchema）', () => {
  it('纯空白 sourceUrl → provenance/source schema safeParse 失败；非空通过', () => {
    expect(
      snapshotProvenanceSchema.safeParse({ sourceUrl: '   ', sourceConfidence: 'official_pricing', lastCheckedDate: '2026-06-20' }).success,
    ).toBe(false);
    expect(
      snapshotProvenanceSchema.safeParse({ sourceUrl: 'https://example.com/pricing', sourceConfidence: 'official_pricing', lastCheckedDate: '2026-06-20' }).success,
    ).toBe(true);
    expect(snapshotSourceSchema.safeParse({ sourceUrl: '   ', fetchStrategy: 'http', lastCheckedDate: null }).success).toBe(false);
    expect(snapshotSourceSchema.safeParse({ sourceUrl: 'https://example.com/pricing', fetchStrategy: 'http', lastCheckedDate: '2026-06-20' }).success).toBe(true);
  });
});

describe('5c review FIX2：known 价数值合法性读侧 fail-closed（dto superRefine）', () => {
  it('合法 known 价通过；DB 脏价（NaN/负/3 小数）→ safeParse 失败，不返坏快照', () => {
    expect(snapshotPlanSchema.safeParse(known('A', '40.00', 'CNY')).success).toBe(true);
    for (const bad of ['NaN', '-1', '20.555']) {
      expect(snapshotPlanSchema.safeParse(known('B', bad, 'CNY')).success).toBe(false);
    }
  });
});
