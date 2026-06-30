/**
 * 快照 rebuild 耦合 + 版本失效集成测试（task 5.4，**需本地 Postgres**，design D8）。
 *
 * 覆盖 spec「快照版本与 ETag 必须随数据变更失效」「API 与快照路径只读」端到端（经真 builder + 注入 now）：
 * ① 改价经公开 `recordPriceChange` → 最外层事务提交后触发 rebuild → ETag 变、缓存反映新价；
 * ② 改价经 `upsertPlan` 委托路径（price-delegated）→ 同样触发 rebuild → ETag 变；
 * ③ 「改价后未 rebuild」不被当作已更新（缓存不 on-read 自动刷；直接 DB 写不触发 rebuild → version 不变，
 *    rebuild 后才变）；
 * ④ 保鲜回路 flag 写（不经改价入口）→ 直接调 rebuild job body（注入 now）→ reviewStatus 反映 + ETag 变；
 * ⑤ staleness 阈值穿越（注入 now 跨阈值、无 DB 写）→ ETag 变（不 304-with-stale）；
 * ⑥ 注入 now 推进但不跨阈值 + 无变更 → ETag 稳定（304 命中）；
 * ⑦ 请求路径只读不写库（getSnapshot 前后 mr_* 行数不变）。
 *
 * ⑤⑥ 用 builder 全局读后**按本套件 plan id 过滤**再哈希，隔离同库其它行的 staleness 干扰（version 是全快照
 * 哈希，跨 now 直接比全局哈希会被无关行翻转污染）。缺 DATABASE_URL 自动 skip。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, like, sql } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// 组 D：recordPriceChange/upsertPlan 提交后经 runSnapshotRebuild 调真 publisher（短连接连真 Redis）。
// 全局 mock invalidation 把 publish 换成 no-op spy，既守「测试绝不连真 Redis」红线，又供 4.8 断言 publish 时序。
vi.mock('../invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const { buildModelRadarSnapshot } = await import('../build.js');
const {
  computeSnapshotVersion,
  rebuildModelRadarSnapshot,
  getModelRadarSnapshot,
  invalidateModelRadarSnapshot,
  peekCachedSnapshot,
} = await import('../cache.js');
const { runSnapshotRebuild } = await import('../rebuild.js');
const { recordPriceChange, _recordPriceChangeTx } = await import(
  '../../ingest/record-price-change.js'
);
const { upsertVendor, upsertPlan } = await import('../../ingest/upsert.js');
const { setReviewFlag } = await import('../../write/flag.js');
const { publishSnapshotInvalidation } = await import('../invalidation.js');
const publishSpy = vi.mocked(publishSnapshotInvalidation);

const PREFIX = 'mr-rebuild-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const NOW = new Date();
// build.ts env-clean 后 thresholdDays 必填、无默认；显式喂 = env.MR_STALENESS_THRESHOLD_DAYS 默认（与 cache/排程同口径），保行为等价。
const THRESHOLD_DAYS = 30;

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.reason, `${PREFIX}%`));
  await db.delete(schema.mrPriceHistory).where(like(schema.mrPriceHistory.sourceUrl, `${PREFIX}%`));
  const srcIds = (
    await db.select({ id: schema.mrSource.id }).from(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`))
  ).map((r) => r.id);
  if (srcIds.length) {
    await db.delete(schema.mrPlanSources).where(inArray(schema.mrPlanSources.sourceId, srcIds));
  }
  await db.delete(schema.mrPlanPrices).where(like(schema.mrPlanPrices.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanLimits).where(like(schema.mrPlanLimits.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

beforeAll(cleanup);
beforeEach(() => invalidateModelRadarSnapshot());
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

async function makeVendor(suffix: string): Promise<string> {
  const [v] = await db!
    .insert(schema.mrVendors)
    .values({ normalizedName: `${PREFIX}v-${suffix}`, name: `Vendor ${suffix}` })
    .returning();
  return v!.id;
}

interface PlanOpts {
  currentPrice?: string | null;
  currency?: string | null;
  sourceConfidence?: string;
  lastChecked?: Date;
}

async function makePlan(vendorId: string, suffix: string, opts: PlanOpts = {}): Promise<string> {
  const [plan] = await db!
    .insert(schema.mrPlans)
    .values({
      vendorId,
      name: `${PREFIX}plan-${suffix}`,
      category: 'coding_plan',
      currentPrice: opts.currentPrice === undefined ? '20.00' : opts.currentPrice,
      currency: opts.currency === undefined ? 'USD' : opts.currency,
      sourceUrl: `${PREFIX}src-${suffix}`,
      lastChecked: opts.lastChecked ?? NOW,
      sourceConfidence: opts.sourceConfidence ?? 'official_pricing',
    })
    .returning();
  return plan!.id;
}

/** 取缓存快照中本套件指定 plan（按 id 定位，builder 全局读）。 */
function cachedPlan(planId: string) {
  return peekCachedSnapshot()!.snapshot.plans.find((p) => p.id === planId);
}

describeIfDb('5.4 rebuild 耦合 + 版本失效', () => {
  it('改价经 recordPriceChange 提交后触发 rebuild → ETag 变、缓存反映新价', async () => {
    const vendorId = await makeVendor('rpc');
    const planId = await makePlan(vendorId, 'rpc', { currentPrice: '20.00', currency: 'USD' });

    // warm 缓存（注入 NOW）。
    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;
    expect(cachedPlan(planId)!.currentPrice).toBe('20.00');

    // 经公开改价入口改 20→30（official_pricing）；hook 在提交后触发 rebuild。
    const outcome = await recordPriceChange(
      {
        planId,
        newValue: '30.00',
        currency: 'USD',
        provenance: { sourceUrl: `${PREFIX}prov-rpc`, sourceConfidence: 'official_pricing' },
      },
      db!,
    );
    expect(outcome.outcome).toBe('appended');

    const after = peekCachedSnapshot()!;
    expect(after.version).not.toBe(v0);
    expect(cachedPlan(planId)!.currentPrice).toBe('30.00');
    expect(cachedPlan(planId)!.priceStatus).toBe('known');
  });

  it('改价经 upsertPlan 委托路径（price-delegated）提交后触发 rebuild → ETag 变', async () => {
    const v = await upsertVendor(db!, { normalizedName: `${PREFIX}v-up`, name: 'Vendor up' });
    const created = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}plan-up`,
      category: 'coding_plan',
      currentPrice: '20.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-up`,
      sourceConfidence: 'official_pricing',
    });
    const planId = 'id' in created ? created.id : undefined;
    expect(planId).toBeDefined();

    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;

    // 同 vendor+name 重录、价 20→30 → 走 _recordPriceChangeTx 委托（price-delegated）；hook 提交后 rebuild。
    const re = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}plan-up`,
      category: 'coding_plan',
      currentPrice: '30.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-up`,
      sourceConfidence: 'official_pricing',
    });
    expect(re.outcome).toBe('price-delegated');

    expect(peekCachedSnapshot()!.version).not.toBe(v0);
    expect(cachedPlan(planId!)!.currentPrice).toBe('30.00');
  });

  it('改价后未 rebuild 不被当作已更新（缓存不 on-read 自动刷；rebuild 后才反映）', async () => {
    const vendorId = await makeVendor('norebuild');
    const planId = await makePlan(vendorId, 'norebuild', { currentPrice: '20.00', currency: 'USD' });
    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;

    // 绕过改价入口直接 DB 写（无 hook）→ 缓存不自动刷新。
    await db!.update(schema.mrPlans).set({ currentPrice: '50.00' }).where(eq(schema.mrPlans.id, planId));

    // getSnapshot 命中旧缓存：version 仍 v0、价仍 20（请求路径不触发 rebuild、不读新值）。
    const served = await getModelRadarSnapshot(db!, NOW);
    expect(served.version).toBe(v0);
    expect(cachedPlan(planId)!.currentPrice).toBe('20.00');

    // 显式 rebuild 后才反映新价、ETag 才变。
    await runSnapshotRebuild({ dbh: db!, now: NOW });
    expect(peekCachedSnapshot()!.version).not.toBe(v0);
    expect(cachedPlan(planId)!.currentPrice).toBe('50.00');
  });

  it('保鲜回路 flag 写 → 直接调 rebuild job body(注入 now) → reviewStatus 反映 + ETag 变', async () => {
    const vendorId = await makeVendor('flag');
    const planId = await makePlan(vendorId, 'flag');
    const v0 = (await runSnapshotRebuild({ dbh: db!, now: NOW })).version!;
    expect(cachedPlan(planId)!.reviewStatus.pending).toBe(false);

    // 保鲜回路给 plan 打 pending flag（不经改价入口、无 rebuild）。
    await setReviewFlag(db!, { targetType: 'plan', targetId: planId }, `${PREFIX}fresh-loop-pending`);

    // 直接调 rebuild job body（注入 now）。
    const res = await runSnapshotRebuild({ dbh: db!, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.version).not.toBe(v0);
    expect(cachedPlan(planId)!.reviewStatus.pending).toBe(true);
  });

  it('staleness 阈值穿越（注入 now 跨阈值、无 DB 写）→ ETag 变；不跨阈值 + 无变更 → ETag 稳定', async () => {
    // 默认阈值 30 天。plan 自身永鲜（lastChecked=now2），关联源 last_checked=2026-03-01 仅在 now2 跨阈值。
    const now1 = new Date('2026-02-01T00:00:00Z'); // 阈值 2026-01-02 → 源鲜
    const now1b = new Date('2026-02-06T00:00:00Z'); // 阈值 2026-01-07 → 源仍鲜（不跨）
    const now2 = new Date('2026-04-01T00:00:00Z'); // 阈值 2026-03-02 → 源陈旧（跨）
    const vendorId = await makeVendor('stale');
    const planId = await makePlan(vendorId, 'stale', { lastChecked: now2 });
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-stale-edge`,
        vendorId,
        fetchStrategy: 'http',
        lastChecked: new Date('2026-03-01T00:00:00Z'),
      })
      .returning();
    await db!.insert(schema.mrPlanSources).values({ planId, sourceId: src!.id });

    // 按本套件 plan id 过滤后哈希（隔离同库其它行的 staleness 干扰）。
    const versionAt = async (now: Date): Promise<string> => {
      const snap = await buildModelRadarSnapshot(db!, now, THRESHOLD_DAYS);
      const plan = snap.plans.find((p) => p.id === planId)!;
      return computeSnapshotVersion({ plans: [plan] });
    };
    const staleAt = async (now: Date): Promise<boolean> => {
      const snap = await buildModelRadarSnapshot(db!, now, THRESHOLD_DAYS);
      return snap.plans.find((p) => p.id === planId)!.freshness.stale;
    };

    // 不跨阈值 + 无变更 → version 稳定（304 命中）。
    expect(await staleAt(now1)).toBe(false);
    expect(await staleAt(now1b)).toBe(false);
    expect(await versionAt(now1)).toBe(await versionAt(now1b));

    // 跨阈值 → stale 翻转 → version 变（不 304-with-stale）。
    expect(await staleAt(now2)).toBe(true);
    expect(await versionAt(now2)).not.toBe(await versionAt(now1));
  });

  it('请求路径只读不写库（getSnapshot 前后 mr_* 行数不变）', async () => {
    const vendorId = await makeVendor('readonly');
    await makePlan(vendorId, 'readonly');
    await rebuildModelRadarSnapshot(db!, NOW);

    const count = async () =>
      (await db!.select({ id: schema.mrPlans.id }).from(schema.mrPlans)).length;
    const before = await count();
    await getModelRadarSnapshot(db!, NOW);
    await getModelRadarSnapshot(db!, NOW);
    expect(await count()).toBe(before);
  });
});

describeIfDb('4.2 周期 rebuild body（注入推进 now）：stale 翻转 + flag 可见（非 publish）', () => {
  it('跨 staleness 阈值 → cached plan stale 翻转 + 隔离 version 变；不跨 + 无 DB 变 → 隔离 version 稳定', async () => {
    publishSpy.mockClear();
    // 默认阈值 30 天：plan 自身永鲜（lastChecked=now2），关联源 last_checked=2026-03-01 仅在 now2 跨阈值。
    const now1 = new Date('2026-02-01T00:00:00Z'); // 阈值 2026-01-02 → 源鲜
    const now1b = new Date('2026-02-06T00:00:00Z'); // 阈值 2026-01-07 → 源仍鲜（不跨）
    const now2 = new Date('2026-04-01T00:00:00Z'); // 阈值 2026-03-02 → 源陈旧（跨）
    const vendorId = await makeVendor('p-stale');
    const planId = await makePlan(vendorId, 'p-stale', { lastChecked: now2 });
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-p-stale`,
        vendorId,
        fetchStrategy: 'http',
        lastChecked: new Date('2026-03-01T00:00:00Z'),
      })
      .returning();
    await db!.insert(schema.mrPlanSources).values({ planId, sourceId: src!.id });

    // 隔离 version：按本套件 plan id 过滤后哈希，避免同库其它行 staleness 跨 now 翻转污染全局哈希。
    const isoVersion = async (now: Date): Promise<string> => {
      const snap = await buildModelRadarSnapshot(db!, now, THRESHOLD_DAYS);
      return computeSnapshotVersion({ plans: [snap.plans.find((p) => p.id === planId)!] });
    };

    // 周期 rebuild body：注入 now1（不跨阈值）→ cached plan 不陈旧。
    await rebuildModelRadarSnapshot(db!, now1);
    expect(cachedPlan(planId)!.freshness.stale).toBe(false);
    // 不跨阈值 + 无 DB 变 → 隔离 version 稳定（304 命中）。
    expect(await isoVersion(now1)).toBe(await isoVersion(now1b));

    // 周期 rebuild body：注入 now2（跨阈值）→ cached plan 翻 stale=true。
    await rebuildModelRadarSnapshot(db!, now2);
    expect(cachedPlan(planId)!.freshness.stale).toBe(true);
    // 跨阈值 → 隔离 version 变（不 304-with-stale）。
    expect(await isoVersion(now2)).not.toBe(await isoVersion(now1));

    // 周期 rebuild 路径绝不 publish（design D2 承重不变量）。
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('flag 写（不经 publish）经周期 rebuild body 可见：reviewStatus.pending 反映（req-2）', async () => {
    publishSpy.mockClear();
    const vendorId = await makeVendor('p-flag');
    const planId = await makePlan(vendorId, 'p-flag');

    // warm via 周期 rebuild body（非 publish 的 cache fn）。
    await rebuildModelRadarSnapshot(db!, NOW);
    expect(cachedPlan(planId)!.reviewStatus.pending).toBe(false);
    const v0 = peekCachedSnapshot()!.version;

    // 保鲜回路给 plan 打 pending flag（setReviewFlag 不经 runSnapshotRebuild、不 publish）。
    await setReviewFlag(db!, { targetType: 'plan', targetId: planId }, `${PREFIX}p-flag-pending`);

    // 再调周期 rebuild body → 反映 pending + version 变（证「不走 publish 的 flag 写经周期 rebuild 可见」）。
    await rebuildModelRadarSnapshot(db!, NOW);
    expect(cachedPlan(planId)!.reviewStatus.pending).toBe(true);
    expect(peekCachedSnapshot()!.version).not.toBe(v0);
    // 全程未经 publish（flag 可见性走周期 rebuild，非 pub/sub）。
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describeIfDb('4.4 只读不变量：周期 rebuild / 订阅回调路径不写 mr_*、不 bump mr_catalog_version', () => {
  it('多次周期 rebuild + 订阅回调(invalidate) 前后 mr_* 行数与 mr_catalog_version 不变', async () => {
    const vendorId = await makeVendor('p-ro');
    await makePlan(vendorId, 'p-ro');

    const counts = async () => ({
      plans: (await db!.select({ id: schema.mrPlans.id }).from(schema.mrPlans)).length,
      flags: (await db!.select({ id: schema.mrReviewFlag.id }).from(schema.mrReviewFlag)).length,
      history: (await db!.select({ id: schema.mrPriceHistory.id }).from(schema.mrPriceHistory))
        .length,
      sources: (await db!.select({ id: schema.mrSource.id }).from(schema.mrSource)).length,
      catalog: (await db!.select({ id: schema.mrCatalogVersion.id }).from(schema.mrCatalogVersion))
        .length,
    });

    const before = await counts();
    // 周期 rebuild body（cache fn）多次 + 订阅回调路径（invalidate 清进程内缓存，无 DB 写）。
    await rebuildModelRadarSnapshot(db!, NOW);
    await rebuildModelRadarSnapshot(db!, new Date());
    invalidateModelRadarSnapshot(); // = subscriber onInvalidate 路径
    await rebuildModelRadarSnapshot(db!, NOW);
    expect(await counts()).toEqual(before);
  });
});

describeIfDb('4.8 提交后才 publish（B3，publish 不在事务回调内）', () => {
  it('history-conflict 分支：_recordPriceChangeTx 在事务内调 setReviewFlag，但绝不在事务内 publish', async () => {
    publishSpy.mockClear();
    const vendorId = await makeVendor('txpub');
    const planId = await makePlan(vendorId, 'txpub', { currentPrice: '20.00', currency: 'USD' });
    const prov = { sourceUrl: `${PREFIX}prov-txpub`, sourceConfidence: 'official_pricing' };
    // 钉死 changed_at 受控复现同刻冲突（仅测试传 nowSql）。
    const FIXED = sql`'2026-06-29 12:00:00.000000+00'::timestamptz`;

    // ① 首次真追加（changed_at=FIXED，20→10）。
    const o1 = await db!.transaction((tx) =>
      _recordPriceChangeTx(tx, { planId, newValue: '10.00', currency: 'USD', provenance: prov }, FIXED),
    );
    expect(o1.outcome).toBe('appended');

    try {
      // ② 同 changed_at 异价 → ON CONFLICT DO NOTHING → 元组异 → history-conflict + 同事务内 setReviewFlag。
      const o2 = await db!.transaction((tx) =>
        _recordPriceChangeTx(tx, { planId, newValue: '99.00', currency: 'USD', provenance: prov }, FIXED),
      );
      expect(o2.outcome).toBe('history-conflict');

      // setReviewFlag 确在事务内写了 pending 标。
      const flags = await db!
        .select({ status: schema.mrReviewFlag.status })
        .from(schema.mrReviewFlag)
        .where(eq(schema.mrReviewFlag.targetId, planId));
      expect(flags.some((f) => f.status === 'pending')).toBe(true);

      // 关键（B3）：publish 只活在 runSnapshotRebuild（最外层提交后），_recordPriceChangeTx 路径绝不触发 publish。
      expect(publishSpy).not.toHaveBeenCalled();
    } finally {
      // 清理：history-conflict flag 的 reason 非 PREFIX 前缀，cleanup 不覆盖，手动删（前置断言失败也须跑，免泄漏到后续用例）。
      await db!.delete(schema.mrReviewFlag).where(eq(schema.mrReviewFlag.targetId, planId));
    }
  });

  it('公开 recordPriceChange：publish 只在最外层事务提交后发出一次（publish 读到已提交新价）', async () => {
    publishSpy.mockClear();
    const vendorId = await makeVendor('postcommit');
    const planId = await makePlan(vendorId, 'postcommit', { currentPrice: '20.00', currency: 'USD' });

    // publish 触发时读 DB：若 publish 在提交后发出，则应读到已提交的新价 30.00（提交前发出会读到旧值/未提交）。
    let priceWhenPublished: string | null | undefined;
    publishSpy.mockImplementationOnce(async () => {
      const rows = await db!
        .select({ price: schema.mrPlans.currentPrice })
        .from(schema.mrPlans)
        .where(eq(schema.mrPlans.id, planId));
      priceWhenPublished = rows[0]?.price ?? null;
    });

    const outcome = await recordPriceChange(
      {
        planId,
        newValue: '30.00',
        currency: 'USD',
        provenance: { sourceUrl: `${PREFIX}prov-postcommit`, sourceConfidence: 'official_pricing' },
      },
      db!,
    );
    expect(outcome.outcome).toBe('appended');
    expect(publishSpy).toHaveBeenCalledTimes(1); // 最外层提交后恰发一次
    expect(priceWhenPublished).toBe('30.00'); // publish 时新价已提交可见 → publish 在 commit 之后
  });
});
