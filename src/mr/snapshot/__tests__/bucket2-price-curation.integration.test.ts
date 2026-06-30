/**
 * 桶2 真价策展 → 快照 → 比价分组**退出验证**集成测（add-model-radar-bucket2-price-curation task 2.1/2.3，
 * **需本地 Postgres**）。仿 build.integration.test.ts 真实 pg 模式 + seed.integration.test.ts 的 runSeed 往返。
 *
 * 覆盖 spec「同档 ≥2 已核同币种真月价使快照满足 compare-web 最划算前置」+「已停售 plan 不留作普通待核」：
 * ① 经 runSeed 灌入组 A 已策展的 6 个 CNY coding_plan 真月价（GLM Lite ¥49 / GLM Pro ¥149 / 百炼 Pro ¥200 /
 *    千帆 Lite ¥40 / 火山 Lite ¥40 / 讯飞无忧 ¥19）+ 腾讯混元停售占位（NULL 价 + review flag）；
 * ② buildModelRadarSnapshot → queryModelRadarSnapshot(category=coding_plan)：(coding_plan, CNY) 组
 *    **`plans.length ≥ 2`**（实为 6，非仅 cheapestPlanId 非 null——后者 ≥1 即过、不证 ≥2）+ `comparable=true` +
 *    `cheapestPlanId` 指向 ¥19 的讯飞无忧 plan；
 * ③ **D2 防拆组（task 2.3①，机器可读）**：目标组全部已核 plan 同一币种 CNY（币种填错会静默拆到别组 → length<6）；
 * ④ **停售纪律（task 2.3②）**：腾讯（停售、NULL 价、带 review flag）priceStatus=unknown、不入任何 cheapest、
 *    不作普通可比待核（落 currency=null 未知组）、reviewStatus.pending=true。
 *
 * builder 全局读（读全库 mr_*），故按 seed vendorId 隔离断言、不假设库内只有 seed 行。
 * 不触网（mock invalidation publisher，仿 bucket2-curation：守「测试绝不连真 Redis」并免 publish 阻塞）；
 * 缺 DATABASE_URL **或非本地 DB** 自动跳过（fail-closed：cleanup 销毁性删 SEED_VENDORS 行，不对非一次性 DB 跑）；afterAll 按 SEED_VENDORS 反查清理自造行。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';
import type { SnapshotPlan, SnapshotPlanGroup } from '../dto.js';

const databaseUrl = process.env.DATABASE_URL;

// fail-closed（CR）：本套件 cleanup 按 SEED_VENDORS normalizedName **销毁性删行**，仅对**本地/一次性** DB 安全；
// DATABASE_URL 指向远程/生产 DB 会误删共享厂商行（不止本套件自造行）。故仅当 host 为 localhost/127.0.0.1/::1
// 才跑（CI postgres service + 本地 dev 均本地）；指向非本地 DB → 跳过（不对非一次性 DB 跑销毁性 cleanup）。
const isLocalDb = !!databaseUrl && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(databaseUrl);

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// runSeed 对已策展真价 plan 经 upsertPlan 落 current_price，其 post-commit runSnapshotRebuild 会调真 publisher
// （连 env.REDIS_URL）。mock 成 no-op，守「测试绝不连真 Redis」红线并免 Redis-down 时每次 publish 阻塞 ~1s（仿 bucket2-curation）。
vi.mock('../invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const { buildModelRadarSnapshot } = await import('../build.js');
const { queryModelRadarSnapshot, modelRadarQueryParamsSchema } = await import('../query.js');
const { runSeed } = await import('../../ingest/seed.js');
const { SEED_VENDORS } = await import('../../ingest/seed-data.js');

const pool = isLocalDb ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = isLocalDb ? describe : describe.skip;

const SEED_NORMALIZED_NAMES = SEED_VENDORS.map((v) => v.normalizedName);
// build.ts env-clean 后 thresholdDays 必填、无默认；显式喂 = env.MR_STALENESS_THRESHOLD_DAYS 默认（与排程同口径），保行为等价。
const THRESHOLD_DAYS = 30;

/** 按 fixture 的 vendor normalized_name 反查并清理全部自造行（无前缀，按 vendor 链下钻删；仿 seed.integration）。 */
async function cleanup() {
  if (!db) return;
  const vendors = await db
    .select({ id: schema.mrVendors.id })
    .from(schema.mrVendors)
    .where(inArray(schema.mrVendors.normalizedName, SEED_NORMALIZED_NAMES));
  const vendorIds = vendors.map((v) => v.id);
  if (vendorIds.length === 0) return;

  const planIds = (
    await db.select({ id: schema.mrPlans.id }).from(schema.mrPlans).where(inArray(schema.mrPlans.vendorId, vendorIds))
  ).map((p) => p.id);
  const sourceIds = (
    await db.select({ id: schema.mrSource.id }).from(schema.mrSource).where(inArray(schema.mrSource.vendorId, vendorIds))
  ).map((s) => s.id);

  if (planIds.length > 0) {
    await db.delete(schema.mrPriceHistory).where(inArray(schema.mrPriceHistory.planId, planIds));
    await db.delete(schema.mrPlanSources).where(inArray(schema.mrPlanSources.planId, planIds));
    await db.delete(schema.mrPlanModels).where(inArray(schema.mrPlanModels.planId, planIds));
    await db.delete(schema.mrPlanClients).where(inArray(schema.mrPlanClients.planId, planIds));
    await db.delete(schema.mrPlanLimits).where(inArray(schema.mrPlanLimits.planId, planIds));
    await db
      .delete(schema.mrReviewFlag)
      .where(and(eq(schema.mrReviewFlag.targetType, 'plan'), inArray(schema.mrReviewFlag.targetId, planIds)));
    await db.delete(schema.mrPlans).where(inArray(schema.mrPlans.id, planIds));
  }
  if (sourceIds.length > 0) {
    await db.delete(schema.mrSource).where(inArray(schema.mrSource.id, sourceIds));
  }
  await db.delete(schema.mrModels).where(inArray(schema.mrModels.vendorId, vendorIds));
  await db.delete(schema.mrVendors).where(inArray(schema.mrVendors.id, vendorIds));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('2.1/2.3 桶2 真价策展 → 快照 → 比价分组退出验证', () => {
  let cnyGroup: SnapshotPlanGroup;
  let nullGroup: SnapshotPlanGroup | undefined;
  let allCheapestIds: (string | null)[];
  let tencent: SnapshotPlan | undefined;

  beforeAll(async () => {
    await runSeed(db!);

    // builder 全局读 → 按 seed vendorId 隔离断言（库内可能含他套件残留/旧 seed 行）。
    const seedVendorIds = new Set(
      (
        await db!
          .select({ id: schema.mrVendors.id })
          .from(schema.mrVendors)
          .where(inArray(schema.mrVendors.normalizedName, SEED_NORMALIZED_NAMES))
      ).map((v) => v.id),
    );
    const snapshot = await buildModelRadarSnapshot(db!, new Date(), THRESHOLD_DAYS);
    const seedPlans = snapshot.plans.filter((p) => seedVendorIds.has(p.vendorId));

    const { groups } = queryModelRadarSnapshot(
      { plans: seedPlans },
      modelRadarQueryParamsSchema.parse({ category: 'coding_plan' }),
    );
    cnyGroup = groups.find((g) => g.sortScope.currency === 'CNY')!;
    nullGroup = groups.find((g) => g.sortScope.currency === null);
    allCheapestIds = groups.map((g) => g.cheapestPlanId);
    tencent = seedPlans.find((p) => p.name.includes('腾讯混元'));
  });

  it('(coding_plan, CNY) 同档 plans.length≥2 + comparable=true + cheapest 指向 ¥19 讯飞无忧（task 2.1）', () => {
    expect(cnyGroup).toBeDefined();
    // ≥2 闸：断言组内 plans.length≥2（非仅 cheapestPlanId 非 null——后者 ≥1 即过、不证 ≥2，design D6）。
    expect(cnyGroup.plans.length).toBeGreaterThanOrEqual(2);
    // 组内全部已核（known）——验 ≥2 已核同币种真月价，不 pin 恰 6（容未来策展增补）。
    expect(cnyGroup.plans.every((p) => p.priceStatus === 'known')).toBe(true);
    expect(cnyGroup.comparable).toBe(true);

    const cheapest = cnyGroup.plans.find((p) => p.id === cnyGroup.cheapestPlanId);
    expect(cheapest).toBeDefined();
    expect(cheapest!.name).toContain('讯飞'); // 讯飞星火 Coding Plan
    expect(Number(cheapest!.currentPrice)).toBe(19); // 同档最低 ¥19
  });

  it('D2 防拆组：目标组全部已核 plan 同一币种 CNY（task 2.3①，机器可读）', () => {
    expect(cnyGroup.plans.every((p) => p.currency === 'CNY')).toBe(true);
    expect(cnyGroup.plans.every((p) => p.priceStatus === 'known')).toBe(true);
  });

  it('停售纪律：腾讯（NULL 价 + review flag）unknown、不入 cheapest、落未知组、pending（task 2.3②）', () => {
    expect(tencent).toBeDefined();
    expect(tencent!.priceStatus).toBe('unknown');
    expect(tencent!.currentPrice).toBeNull();
    // 带「已停售」review flag → 待复核（不留作普通待核暗示待定价）。
    expect(tencent!.reviewStatus.pending).toBe(true);
    // 不入任何 cheapest，不在 CNY 可比组。
    expect(allCheapestIds).not.toContain(tencent!.id);
    expect(cnyGroup.plans.some((p) => p.id === tencent!.id)).toBe(false);
    // 落 currency=null 未知组（非普通可比待核）。
    expect(nullGroup).toBeDefined();
    expect(nullGroup!.plans.some((p) => p.id === tencent!.id)).toBe(true);
  });
});
