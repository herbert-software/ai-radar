/**
 * Model Radar 只读比价 HTTP 路由测试（组 E，task 4.4）——合成快照注入、`app.request(...)`、**不触 DB**。
 *
 * 覆盖：按 model+tool 返回合格 plan、非法参数 400（含裸 family）、跨桶结果无全局 rank（带
 * `sortScope={category,currency}`）、全 unknown 组 currency=null、请求路径只读不写库；并含一条 official_pricing
 * 已核价 fixture 断言 HTTP 响应 cheapest/priceStatus=known 端到端透传。snapshot 端 version/ETag + 304 与冷启动 503 一并覆盖。
 *
 * env 占位：import model-radar.ts → cache.ts → db/index.ts → env.ts 会在 import 期校验 env 并建 Pool；
 * 本套件注入合成 provider、永不调真 `getModelRadarSnapshot`，故 Pool 不会发起连接（仿 cache.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { createModelRadarApp } = await import('../model-radar.js');
const { computeSnapshotVersion } = await import('../../snapshot/cache.js');
type ModelRadarSnapshot = import('../../snapshot/dto.js').ModelRadarSnapshot;
type SnapshotPlan = import('../../snapshot/dto.js').SnapshotPlan;
type ModelRadarQueryResponse = import('../../snapshot/dto.js').ModelRadarQueryResponse;

const PROV_OFFICIAL = {
  sourceUrl: 'https://example.com/pricing',
  sourceConfidence: 'official_pricing' as const,
  lastCheckedDate: '2026-06-20',
};
const PROV_UNKNOWN = {
  sourceUrl: 'https://example.com/x',
  sourceConfidence: 'needs_login_recheck' as const,
  lastCheckedDate: '2026-06-20',
};

/** 已核官方价 plan（priceStatus=known，满足 dto.superRefine）。 */
function known(
  id: string,
  price: string,
  currency: SnapshotPlan['currency'],
  extra: Partial<SnapshotPlan> = {},
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
    provenance: PROV_OFFICIAL,
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [],
    clients: [],
    limits: [],
    sources: [],
    ...extra,
  };
}

/** 未知价 plan（占位 NULL 或非官方 confidence 带价）。 */
function unknown(id: string, extra: Partial<SnapshotPlan> = {}): SnapshotPlan {
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
    provenance: PROV_UNKNOWN,
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [],
    clients: [],
    limits: [],
    sources: [],
    ...extra,
  };
}

/** 合成 provider：返回固定 `{ snapshot, version }`（version = 真内容哈希，端到端对齐组 D）。 */
function provider(snapshot: ModelRadarSnapshot) {
  return async () => ({ snapshot, version: computeSnapshotVersion(snapshot) });
}

/** 深冻结：钉死「请求路径只读、不变异注入快照」。 */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe('GET /model-radar/plans 过滤 + 端到端透传', () => {
  it('按 model+tool 返回合格 plan，priceStatus=known/cheapest 端到端透传', async () => {
    const matching = known('A', '30', 'CNY', {
      models: [{ modelId: 'm1', family: 'glm', version: '4.6', provenance: PROV_OFFICIAL }],
      clients: [{ clientType: 'tool', clientId: 'claude-code', provenance: PROV_OFFICIAL }],
    });
    // 同 family 不同 version → 不应命中 model=glm:4.6。
    const wrongVersion = known('B', '10', 'CNY', {
      models: [{ modelId: 'm2', family: 'glm', version: '4.5', provenance: PROV_OFFICIAL }],
      clients: [{ clientType: 'tool', clientId: 'claude-code', provenance: PROV_OFFICIAL }],
    });
    const app = createModelRadarApp(provider({ plans: [matching, wrongVersion] }));

    const res = await app.request('/model-radar/plans?model=glm:4.6&tool=claude-code');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelRadarQueryResponse;

    const ids = body.groups.flatMap((g) => g.plans.map((p) => p.id));
    expect(ids).toEqual(['A']);
    const cny = body.groups.find((g) => g.sortScope.currency === 'CNY')!;
    expect(cny.cheapestPlanId).toBe('A');
    expect(cny.comparable).toBe(true);
    // priceStatus=known + provenance 端到端透传（未被序列化丢失）。
    expect(cny.plans[0]!.priceStatus).toBe('known');
    expect(cny.plans[0]!.provenance.sourceConfidence).toBe('official_pricing');
  });

  it('跨桶/跨币结果按 (category, currency) 分组、带 sortScope、无全局 rank', async () => {
    const snap = {
      plans: [
        known('C', '20', 'EUR'),
        known('D', '40', 'CNY'),
        known('E', '5', 'USD', { category: 'token_plan' }),
      ],
    };
    const res = await createModelRadarApp(provider(snap)).request('/model-radar/plans');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelRadarQueryResponse & Record<string, unknown>;

    // 每组都带 sortScope={category,currency}；顶层无全局 rank/cheapest 字段。
    expect(body.groups.length).toBe(3);
    for (const g of body.groups) {
      expect(g.sortScope).toHaveProperty('category');
      expect(g.sortScope).toHaveProperty('currency');
      // 每组内币种唯一（不跨币比较）。
      expect(new Set(g.plans.map((p) => p.currency)).size).toBe(1);
    }
    expect(body).not.toHaveProperty('cheapestPlanId');
    expect(body).not.toHaveProperty('rank');
  });

  it('全 unknown → currency=null 组、cheapest=null、comparable=false', async () => {
    const snap = { plans: [unknown('A'), unknown('B', { currentPrice: '40', currency: 'CNY' })] };
    const res = await createModelRadarApp(provider(snap)).request('/model-radar/plans');
    const body = (await res.json()) as ModelRadarQueryResponse;

    expect(body.groups).toHaveLength(1);
    const g = body.groups[0]!;
    expect(g.sortScope.currency).toBeNull();
    expect(g.cheapestPlanId).toBeNull();
    expect(g.comparable).toBe(false);
    expect(g.unknownCount).toBe(2);
  });

  it('非法参数 → 400（裸 family / 未知参数 / 裸预算），不宽松兜底', async () => {
    const app = createModelRadarApp(provider({ plans: [] }));
    for (const q of ['model=glm', 'foo=bar', 'maxMonthlyPrice=100', 'category=bogus']) {
      const res = await app.request(`/model-radar/plans?${q}`);
      expect(res.status).toBe(400);
    }
  });

  it('非法参数优先于快照可用性：坏参数 + 抛错 provider → 仍 400', async () => {
    const throwing = createModelRadarApp(async () => {
      throw new Error('cold start fail');
    });
    expect((await throwing.request('/model-radar/plans?model=glm')).status).toBe(400);
  });

  it('请求路径只读：注入深冻结快照，多次请求不变异、不写库', async () => {
    const snap = deepFreeze({ plans: [known('A', '30', 'CNY'), unknown('B')] });
    const app = createModelRadarApp(provider(snap as ModelRadarSnapshot));
    // 冻结快照下若请求路径试图变异会抛 TypeError；正常返回即证明只读。
    expect((await app.request('/model-radar/plans')).status).toBe(200);
    expect((await app.request('/model-radar/plans?requiresKnownPrice=true')).status).toBe(200);
    expect((await app.request('/model-radar/snapshot')).status).toBe(200);
    expect(Object.isFrozen(snap.plans[0])).toBe(true);
  });
});

describe('GET /model-radar/snapshot version/ETag + 503', () => {
  it('返回 version + 公开快照子集，并设 ETag 头', async () => {
    const snap = { plans: [known('A', '30', 'CNY')] };
    const expected = computeSnapshotVersion(snap as ModelRadarSnapshot);
    const res = await createModelRadarApp(provider(snap)).request('/model-radar/snapshot');

    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${expected}"`);
    const body = (await res.json()) as { version: string; snapshot: ModelRadarSnapshot };
    expect(body.version).toBe(expected);
    expect(body.snapshot.plans[0]!.id).toBe('A');
  });

  it('If-None-Match 命中当前内容哈希 → 304', async () => {
    const snap = { plans: [known('A', '30', 'CNY')] };
    const app = createModelRadarApp(provider(snap));
    const first = await app.request('/model-radar/snapshot');
    const etag = first.headers.get('ETag')!;

    const second = await app.request('/model-radar/snapshot', {
      headers: { 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('冷启动首建失败 → 503（不返回坏快照）', async () => {
    const app = createModelRadarApp(async () => {
      throw new Error('cold start build failed');
    });
    expect((await app.request('/model-radar/snapshot')).status).toBe(503);
    expect((await app.request('/model-radar/plans')).status).toBe(503);
  });

  it('503 路径打 server 端日志（transient 与坏快照可区分，FIX5）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createModelRadarApp(async () => {
      throw new Error('cold start build failed');
    });
    await app.request('/model-radar/snapshot');
    await app.request('/model-radar/plans');
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});
