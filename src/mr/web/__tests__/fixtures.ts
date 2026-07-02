/**
 * 组 C 测试用合成快照 fixture（add-model-radar-compare-web-page / task 7.x）。
 *
 * **不是测试文件**（无 `.test.` 后缀，vitest 不收集）——render.test.ts / page.test.ts 共享的造数工具。
 * 全合成、in-memory、不触 DB/Redis（测试安全红线）。形状对齐 `src/mr/snapshot/dto.ts`，
 * 风格对齐 `src/mr/snapshot/__tests__/query.test.ts`（known 满足 dto.superRefine）。
 */
import type { CachedSnapshot } from '../../snapshot/cache.js';
import type {
  ModelRadarSnapshot,
  SnapshotClient,
  SnapshotLimit,
  SnapshotModel,
  SnapshotPeriodPrice,
  SnapshotPlan,
  SnapshotPlanGroup,
  SnapshotProvenance,
  SnapshotSource,
} from '../../snapshot/dto.js';

/** 默认事实 provenance（official_pricing、有 date）。 */
export function prov(over: Partial<SnapshotProvenance> = {}): SnapshotProvenance {
  return {
    sourceUrl: 'https://example.com/pricing',
    sourceConfidence: 'official_pricing',
    lastCheckedDate: '2026-06-20',
    ...over,
  };
}

/** 已核官方价 plan（priceStatus=known，满足 dto.superRefine：价/币非 NULL + 官方 confidence）。 */
export function known(
  id: string,
  price: string,
  currency: SnapshotPlan['currency'],
  over: Partial<SnapshotPlan> = {},
): SnapshotPlan {
  return {
    id,
    vendorId: 'v1',
    vendorName: 'Vendor 1',
    name: id,
    category: 'coding_plan',
    availability: 'unknown',
    currentPrice: price,
    currency,
    priceStatus: 'known',
    provenance: prov(),
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [],
    clients: [],
    limits: [],
    sources: [],
    ...over,
  };
}

/** 未核价 plan（占位 NULL 价 / needs_login_recheck）。 */
export function unknown(id: string, over: Partial<SnapshotPlan> = {}): SnapshotPlan {
  return {
    id,
    vendorId: 'v1',
    vendorName: 'Vendor 1',
    name: id,
    category: 'coding_plan',
    availability: 'unknown',
    currentPrice: null,
    currency: null,
    priceStatus: 'unknown',
    provenance: prov({ sourceConfidence: 'needs_login_recheck' }),
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [],
    clients: [],
    limits: [],
    sources: [],
    ...over,
  };
}

/**
 * 季/年付周期价行。`price===null` → 未核（priceStatus=unknown，effectiveMonthly 必为 null，对齐 dto.superRefine）；
 * 否则已核，`em` 须为 `price/divisor`（quarterly÷3、annual÷12）以合 superRefine。
 */
export function periodPrice(
  billingPeriod: SnapshotPeriodPrice['billingPeriod'],
  price: string | null,
  currency: SnapshotPeriodPrice['currency'],
  em: number | null,
  over: Partial<SnapshotPeriodPrice> = {},
): SnapshotPeriodPrice {
  return {
    billingPeriod,
    price,
    currency,
    priceStatus: price === null ? 'unknown' : 'known',
    provenance: prov(),
    effectiveMonthly: em,
    ...over,
  };
}

export function model(
  family: string,
  version: string,
  provOver: Partial<SnapshotProvenance> = {},
): SnapshotModel {
  return {
    modelId: `${family}-${version || 'na'}`,
    family,
    version,
    provenance: prov({ sourceConfidence: 'official_doc', ...provOver }),
  };
}

export function client(
  clientType: SnapshotClient['clientType'],
  clientId: string,
  provOver: Partial<SnapshotProvenance> = {},
): SnapshotClient {
  return { clientType, clientId, provenance: prov({ sourceConfidence: 'official_doc', ...provOver }) };
}

export function limit(
  limitType: SnapshotLimit['limitType'],
  value: string | null,
  window: string,
  provOver: Partial<SnapshotProvenance> = {},
): SnapshotLimit {
  return { limitType, value, window, provenance: prov(provOver) };
}

export function source(
  sourceUrl: string,
  fetchStrategy: SnapshotSource['fetchStrategy'],
  lastCheckedDate: string | null,
): SnapshotSource {
  return { sourceUrl, fetchStrategy, lastCheckedDate };
}

export function snap(...plans: SnapshotPlan[]): ModelRadarSnapshot {
  return { plans };
}

/** 注入给 createModelRadarWebApp 的合成快照提供者（不触 DB）。 */
export function provider(snapshot: ModelRadarSnapshot, version = 'v1'): () => Promise<CachedSnapshot> {
  return async () => ({ snapshot, version });
}

/** 手搓一个 (category,currency) 查询组（render.ts cheapestInfo 直测用）。 */
export function group(over: Partial<SnapshotPlanGroup> = {}): SnapshotPlanGroup {
  return {
    sortScope: { category: 'coding_plan', currency: 'CNY' },
    plans: [known('A', '30', 'CNY'), known('B', '40', 'CNY')],
    cheapestPlanId: 'A',
    comparable: true,
    unknownCount: 0,
    ...over,
  };
}
