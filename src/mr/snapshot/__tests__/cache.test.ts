/**
 * 快照缓存 + 版本/ETag 纯单测（task 5.4，**无 DB**，design D2/D8）。
 *
 * 覆盖缓存语义与「ETag = 服务表征纯函数」的内容哈希契约，用注入 `buildFn` 桩验证、不触 DB：
 * ① 坏快照（build 抛错）不覆盖既有可用快照、仍服务旧快照（fail-closed）；
 * ② invalidate + rebuild 后数据可见且 version 变化；
 * ③ version = canonical 内容哈希：同服务表征 → 同 version（含字段书写顺序无关）、内容变 → version 变；
 * ④ **staleness 离散 `stale` 翻转 → version 变**（阈值穿越翻转 ETag 的版本层证据，不 304-with-stale）；
 *    **服务表征无变化 → version 稳定**（不跨阈值无变更 → 304 命中的版本层证据）；
 * ⑤ 冷启动首建失败上抛、不缓存（供组 E 接 503）；
 * ⑥ warm 后 get 不再调 buildFn（请求路径命中缓存、不触 DB）。
 *
 * 阈值穿越/不穿越**经真 builder + 注入 now** 的端到端断言在 rebuild.integration.test.ts（需 DB）；
 * 本文件在版本函数层钉死「stale 翻转 ⇒ 哈希变 / 内容不变 ⇒ 哈希稳」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// 组 D：runSnapshotRebuild 现默认调真 publisher（短连接连真 Redis）。mock invalidation 把它换成 no-op spy，
// 既守「测试绝不连真 Redis」红线，又避免 Redis-down 时每次 publish 阻塞 ~1s 拖慢；4.3 单测据此注入抛错 publish。
vi.mock('../invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const {
  computeSnapshotVersion,
  rebuildModelRadarSnapshot,
  getModelRadarSnapshot,
  invalidateModelRadarSnapshot,
  peekCachedSnapshot,
} = await import('../cache.js');
const { runSnapshotRebuild } = await import('../rebuild.js');
const { publishSnapshotInvalidation } = await import('../invalidation.js');
const publishSpy = vi.mocked(publishSnapshotInvalidation);
type ModelRadarSnapshot = import('../dto.js').ModelRadarSnapshot;
type SnapshotPlan = import('../dto.js').SnapshotPlan;

/** 占位 dbh（注入 buildFn 时不被使用）。 */
const dummyDb = {} as never;
const NOW = new Date('2026-06-29T00:00:00Z');

function makePlan(overrides: Partial<SnapshotPlan> = {}): SnapshotPlan {
  return {
    id: 'p1',
    vendorId: 'v1',
    vendorName: 'Vendor',
    name: 'Coding Plan Pro',
    category: 'coding_plan',
    availability: 'unknown',
    currentPrice: '20.00',
    currency: 'USD',
    priceStatus: 'known',
    provenance: {
      sourceUrl: 'https://x/pricing',
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
    ...overrides,
  };
}

function makeSnapshot(plans: SnapshotPlan[] = [makePlan()]): ModelRadarSnapshot {
  return { plans };
}

/** 返回固定快照的 buildFn 桩。 */
function stubBuild(snapshot: ModelRadarSnapshot) {
  return vi.fn(async () => snapshot);
}

beforeEach(() => {
  invalidateModelRadarSnapshot();
});

describe('5.2 版本 = 服务表征内容哈希（纯函数）', () => {
  it('同服务表征 → 同 version；字段书写顺序无关（canonical 排序对象键）', () => {
    const a = makeSnapshot([makePlan()]);
    // 故意以不同键插入顺序构造等价 plan（canonical 化后应同哈希）。
    const reordered: SnapshotPlan = {
      sources: [],
      limits: [],
      clients: [],
      models: [],
      reviewStatus: { pending: false },
      freshness: { stale: false },
      provenance: {
        sourceConfidence: 'official_pricing',
        sourceUrl: 'https://x/pricing',
        lastCheckedDate: '2026-06-20',
      },
      priceStatus: 'known',
      currency: 'USD',
      currentPrice: '20.00',
      category: 'coding_plan',
      name: 'Coding Plan Pro',
      vendorName: 'Vendor',
      vendorId: 'v1',
      periodPrices: [],
      availability: 'unknown',
      id: 'p1',
    };
    const b = makeSnapshot([reordered]);
    expect(computeSnapshotVersion(a)).toBe(computeSnapshotVersion(b));
  });

  it('语义字段变（价格）→ version 变', () => {
    const v0 = computeSnapshotVersion(makeSnapshot([makePlan({ currentPrice: '20.00' })]));
    const v1 = computeSnapshotVersion(makeSnapshot([makePlan({ currentPrice: '30.00' })]));
    expect(v1).not.toBe(v0);
  });

  it('离散 stale 翻转 → version 变（阈值穿越翻转 ETag，不 304-with-stale）', () => {
    const fresh = computeSnapshotVersion(makeSnapshot([makePlan({ freshness: { stale: false } })]));
    const stale = computeSnapshotVersion(makeSnapshot([makePlan({ freshness: { stale: true } })]));
    expect(stale).not.toBe(fresh);
  });

  it('reviewStatus.pending 翻转 → version 变（保鲜回路 flag 反映到 ETag）', () => {
    const clean = computeSnapshotVersion(makeSnapshot([makePlan({ reviewStatus: { pending: false } })]));
    const pending = computeSnapshotVersion(makeSnapshot([makePlan({ reviewStatus: { pending: true } })]));
    expect(pending).not.toBe(clean);
  });

  it('availability 变化 → version 变', () => {
    const v0 = computeSnapshotVersion(makeSnapshot([makePlan({ availability: 'on_sale' })]));
    const v1 = computeSnapshotVersion(makeSnapshot([makePlan({ availability: 'discontinued' })]));
    expect(v1).not.toBe(v0);
  });

  it('period row price/provenance/date/effectiveMonthly 变化 → version 变；无变更 rebuild 稳定', () => {
    const period = {
      billingPeriod: 'annual' as const,
      price: '468.00',
      currency: 'CNY' as const,
      priceStatus: 'known' as const,
      provenance: {
        sourceUrl: 'https://x/annual',
        sourceConfidence: 'official_pricing' as const,
        lastCheckedDate: '2026-06-20',
      },
      effectiveMonthly: 39,
    };
    const base = makeSnapshot([makePlan({ currency: 'CNY', periodPrices: [period] })]);
    const same = makeSnapshot([makePlan({ currency: 'CNY', periodPrices: [{ ...period }] })]);
    expect(computeSnapshotVersion(same)).toBe(computeSnapshotVersion(base));

    const priceChanged = makeSnapshot([
      makePlan({
        currency: 'CNY',
        periodPrices: [{ ...period, price: '456.00', effectiveMonthly: 38 }],
      }),
    ]);
    const provenanceChanged = makeSnapshot([
      makePlan({
        currency: 'CNY',
        periodPrices: [
          {
            ...period,
            provenance: { ...period.provenance, sourceUrl: 'https://x/new-annual' },
          },
        ],
      }),
    ]);
    const dateChanged = makeSnapshot([
      makePlan({
        currency: 'CNY',
        periodPrices: [
          {
            ...period,
            provenance: { ...period.provenance, lastCheckedDate: '2026-06-21' },
          },
        ],
      }),
    ]);
    expect(computeSnapshotVersion(priceChanged)).not.toBe(computeSnapshotVersion(base));
    expect(computeSnapshotVersion(provenanceChanged)).not.toBe(computeSnapshotVersion(base));
    expect(computeSnapshotVersion(dateChanged)).not.toBe(computeSnapshotVersion(base));
  });
});

describe('5.1/5.4 缓存 fail-closed + 失效 + 只读命中', () => {
  it('坏快照（build 抛错）不覆盖既有快照、仍服务旧快照', async () => {
    const good = makeSnapshot([makePlan({ currentPrice: '20.00' })]);
    const warm = await rebuildModelRadarSnapshot(dummyDb, NOW, stubBuild(good));
    const goodVersion = warm.version;

    const throwingBuild = vi.fn(async () => {
      throw new Error('schema 校验失败（坏快照）');
    });
    // rebuild 抛错。
    await expect(rebuildModelRadarSnapshot(dummyDb, NOW, throwingBuild)).rejects.toThrow();
    // 旧快照仍在、未被覆盖。
    const after = peekCachedSnapshot();
    expect(after).toBeDefined();
    expect(after!.version).toBe(goodVersion);
    expect(after!.snapshot.plans[0]!.currentPrice).toBe('20.00');
    // get 仍服务旧快照、不触发新 build。
    const served = await getModelRadarSnapshot(dummyDb, NOW, throwingBuild);
    expect(served.version).toBe(goodVersion);
  });

  it('invalidate + rebuild 后数据可见且 version 变化', async () => {
    const v0 = (await rebuildModelRadarSnapshot(dummyDb, NOW, stubBuild(makeSnapshot([makePlan({ currentPrice: '20.00' })])))).version;
    invalidateModelRadarSnapshot();
    expect(peekCachedSnapshot()).toBeUndefined();
    const next = await rebuildModelRadarSnapshot(dummyDb, NOW, stubBuild(makeSnapshot([makePlan({ currentPrice: '30.00' })])));
    expect(next.version).not.toBe(v0);
    expect(next.snapshot.plans[0]!.currentPrice).toBe('30.00');
  });

  it('冷启动首建失败上抛且不缓存（供组 E 503）', async () => {
    const throwingBuild = vi.fn(async () => {
      throw new Error('冷启动 DB 不可达');
    });
    await expect(getModelRadarSnapshot(dummyDb, NOW, throwingBuild)).rejects.toThrow();
    expect(peekCachedSnapshot()).toBeUndefined();
  });

  it('并发 rebuild/get 去重：N 并发只 build 1 次、拿同一 version（防冷启动 thundering-herd）', async () => {
    const snap = makeSnapshot([makePlan()]);
    let calls = 0;
    const counting = async (): Promise<ModelRadarSnapshot> => {
      calls += 1;
      return snap;
    };
    const results = await Promise.all([
      rebuildModelRadarSnapshot(dummyDb, NOW, counting),
      rebuildModelRadarSnapshot(dummyDb, NOW, counting),
      getModelRadarSnapshot(dummyDb, NOW, counting),
      getModelRadarSnapshot(dummyDb, NOW, counting),
      rebuildModelRadarSnapshot(dummyDb, NOW, counting),
    ]);
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.version)).size).toBe(1);

    // build 抛后 inFlight 须清空：下一次 rebuild 仍能重新 build（不被卡在已 settle 的旧 inFlight）。
    invalidateModelRadarSnapshot();
    await expect(
      rebuildModelRadarSnapshot(dummyDb, NOW, async () => {
        throw new Error('冷启动失败');
      }),
    ).rejects.toThrow();
    let retried = 0;
    await rebuildModelRadarSnapshot(dummyDb, NOW, async () => {
      retried += 1;
      return makeSnapshot([makePlan({ currentPrice: '30.00' })]);
    });
    expect(retried).toBe(1);
  });

  it('warm 后 get 命中缓存、不再调 buildFn（请求路径不触 DB）', async () => {
    const build = stubBuild(makeSnapshot());
    await getModelRadarSnapshot(dummyDb, NOW, build); // 冷启动 1 次
    expect(build).toHaveBeenCalledTimes(1);
    await getModelRadarSnapshot(dummyDb, NOW, build); // 命中、不再 build
    await getModelRadarSnapshot(dummyDb, NOW, build);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('cache 显式喂 thresholdDays 给 buildFn（build.ts env-clean 后必填、无默认；design D5）', async () => {
    // build.ts 删 `import { env }` 后 thresholdDays 必填；cache 须从 env.MR_STALENESS_THRESHOLD_DAYS 显式喂。
    // 钉死「cache 喂第三参（number）」——否则 build.ts env-clean 后会用到 undefined 阈值（NaN 全陈旧）。
    const spy = vi.fn(async () => makeSnapshot());
    await rebuildModelRadarSnapshot(dummyDb, NOW, spy);
    expect(spy).toHaveBeenCalledWith(dummyDb, NOW, expect.any(Number));
  });
});

describe('5.3b rebuild job body never-throws（fail-closed）', () => {
  it('build 抛错 → 返回 ok:false、不上抛、旧快照保留', async () => {
    const good = makeSnapshot([makePlan({ currentPrice: '20.00' })]);
    const warmed = await runSnapshotRebuild({ dbh: dummyDb, now: NOW, buildFn: stubBuild(good) });
    expect(warmed.ok).toBe(true);
    expect(warmed.planCount).toBe(1);

    const res = await runSnapshotRebuild({
      dbh: dummyDb,
      now: NOW,
      buildFn: async () => {
        throw new Error('坏快照');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.version).toBeNull();
    expect(res.error).toContain('坏快照');
    // 旧快照仍在。
    expect(peekCachedSnapshot()!.version).toBe(warmed.version);
  });

  it('成功 → ok:true + version = 内容哈希', async () => {
    const snap = makeSnapshot([makePlan()]);
    const res = await runSnapshotRebuild({ dbh: dummyDb, now: NOW, buildFn: stubBuild(snap) });
    expect(res.ok).toBe(true);
    expect(res.version).toBe(computeSnapshotVersion(snap));
  });
});

describe('4.3 Redis-down 自愈：publish 抛错下写/重建不受影响', () => {
  it('runSnapshotRebuild 注入抛错 publish → 写仍成功(ok:true)、version 仍出、outcome 不受影响', async () => {
    const throwingPublish = vi.fn(async () => {
      throw new Error('redis down: publish 失败');
    });
    const snap = makeSnapshot([makePlan({ currentPrice: '20.00' })]);
    const res = await runSnapshotRebuild({
      dbh: dummyDb,
      now: NOW,
      buildFn: stubBuild(snap),
      publish: throwingPublish,
    });
    expect(res.ok).toBe(true); // publish 抛错被 runSnapshotRebuild 防御性 try/catch 吞掉、不影响写
    expect(res.version).toBe(computeSnapshotVersion(snap));
    expect(throwingPublish).toHaveBeenCalledTimes(1);
  });

  it('周期 rebuild body(rebuildModelRadarSnapshot) 纯 cache fn：不依赖 Redis、不触 publish', async () => {
    publishSpy.mockClear();
    invalidateModelRadarSnapshot();
    const snap = makeSnapshot([makePlan({ currentPrice: '50.00' })]);
    const built = await rebuildModelRadarSnapshot(dummyDb, NOW, stubBuild(snap));
    expect(built.snapshot.plans[0]!.currentPrice).toBe('50.00');
    // 周期 rebuild 结构上不引用 publisher → Redis 全挂也照常重建（design D2/spec「Redis 全挂周期 rebuild 仍工作」）。
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
