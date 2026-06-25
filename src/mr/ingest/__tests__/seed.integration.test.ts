/**
 * 已核 8 家全桶 seed 录入 + 定位边幂等集成测试（task 1.6/1.7，**需本地 Postgres**，design D9）。
 *
 * 覆盖 spec「mr_plan_sources 定位边可从源定位 plan 集合且幂等录入」/ 场景「重跑录入边幂等」：
 * ① 往返：runSeed 把 8 家 vendor + 各桶 plan/limit/model/client/source/定位边真落库；
 * ② 三桶各 ≥1 例（coding_plan/token_plan/ide_membership）；
 * ③ **幂等重跑**：第二次 runSeed 不报错、不重复——行数与首次一致（identity exists / fact noop / 边 DO NOTHING）；
 * ④ 定位边 `(source_id, plan_id)` 重复 upsertPlanSource = exists、不报错不重复。
 *
 * 不触网 / 不触 LLM；缺 DATABASE_URL 时自动跳过。按 fixture 的 normalized_name 清理自造行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runSeed } = await import('../seed.js');
const { upsertPlanSource } = await import('../upsert.js');
const { SEED_VENDORS } = await import('../seed-data.js');

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const SEED_NORMALIZED_NAMES = SEED_VENDORS.map((v) => v.normalizedName);

/** 按 fixture 的 vendor normalized_name 反查并清理全部自造行（无前缀，故按 vendor 链下钻删）。 */
async function cleanup() {
  if (!db) return;
  const vendors = await db
    .select({ id: schema.mrVendors.id })
    .from(schema.mrVendors)
    .where(inArray(schema.mrVendors.normalizedName, SEED_NORMALIZED_NAMES));
  const vendorIds = vendors.map((v) => v.id);
  if (vendorIds.length === 0) return;

  const plans = await db
    .select({ id: schema.mrPlans.id })
    .from(schema.mrPlans)
    .where(inArray(schema.mrPlans.vendorId, vendorIds));
  const planIds = plans.map((p) => p.id);

  const sources = await db
    .select({ id: schema.mrSource.id })
    .from(schema.mrSource)
    .where(inArray(schema.mrSource.vendorId, vendorIds));
  const sourceIds = sources.map((s) => s.id);

  if (planIds.length > 0) {
    await db.delete(schema.mrPlanSources).where(inArray(schema.mrPlanSources.planId, planIds));
    await db.delete(schema.mrPlanModels).where(inArray(schema.mrPlanModels.planId, planIds));
    await db.delete(schema.mrPlanClients).where(inArray(schema.mrPlanClients.planId, planIds));
    await db.delete(schema.mrPlanLimits).where(inArray(schema.mrPlanLimits.planId, planIds));
    await db.delete(schema.mrReviewFlag).where(
      and(eq(schema.mrReviewFlag.targetType, 'plan'), inArray(schema.mrReviewFlag.targetId, planIds)),
    );
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

describeIfDb('1.6/1.7 seed 录入 + 定位边幂等', () => {
  it('往返：8 家 vendor + 三桶 plan + child + 定位边真落库', async () => {
    const res = await runSeed(db!);
    expect(res.vendors).toBe(SEED_VENDORS.length);
    // 已核 8 家（Token: Kimi/MiniMax/MiMo/Step + IDE: Trae/Qoder/Comate/CodeBuddy）+ coding_plan 典范 Z.ai。
    expect(res.vendors).toBeGreaterThanOrEqual(9);

    const vendors = await db!
      .select({ id: schema.mrVendors.id })
      .from(schema.mrVendors)
      .where(inArray(schema.mrVendors.normalizedName, SEED_NORMALIZED_NAMES));
    expect(vendors).toHaveLength(SEED_VENDORS.length);
    const vendorIds = vendors.map((v) => v.id);

    // 三桶各 ≥1 例。
    const plans = await db!
      .select({ category: schema.mrPlans.category })
      .from(schema.mrPlans)
      .where(inArray(schema.mrPlans.vendorId, vendorIds));
    const categories = new Set(plans.map((p) => p.category));
    expect(categories.has('coding_plan')).toBe(true);
    expect(categories.has('token_plan')).toBe(true);
    expect(categories.has('ide_membership')).toBe(true);

    // 定位边落库（每源 ↔ 同 vendor 全部 plan）。
    const planIds = (
      await db!
        .select({ id: schema.mrPlans.id })
        .from(schema.mrPlans)
        .where(inArray(schema.mrPlans.vendorId, vendorIds))
    ).map((p) => p.id);
    const edges = await db!
      .select()
      .from(schema.mrPlanSources)
      .where(inArray(schema.mrPlanSources.planId, planIds));
    expect(edges.length).toBeGreaterThan(0);
  });

  it('幂等重跑：第二次 runSeed 不报错、行数不增', async () => {
    // 首次已在上一 it 跑过；再跑两次，统计实际库内行数不变。
    const countRows = async () => {
      const vendors = await db!
        .select({ id: schema.mrVendors.id })
        .from(schema.mrVendors)
        .where(inArray(schema.mrVendors.normalizedName, SEED_NORMALIZED_NAMES));
      const vendorIds = vendors.map((v) => v.id);
      const planIds = (
        await db!
          .select({ id: schema.mrPlans.id })
          .from(schema.mrPlans)
          .where(inArray(schema.mrPlans.vendorId, vendorIds))
      ).map((p) => p.id);
      const edges = await db!
        .select({ id: schema.mrPlanSources.id })
        .from(schema.mrPlanSources)
        .where(inArray(schema.mrPlanSources.planId, planIds));
      const limits = await db!
        .select({ id: schema.mrPlanLimits.id })
        .from(schema.mrPlanLimits)
        .where(inArray(schema.mrPlanLimits.planId, planIds));
      return {
        vendors: vendorIds.length,
        plans: planIds.length,
        edges: edges.length,
        limits: limits.length,
      };
    };

    const before = await countRows();
    await runSeed(db!); // 重跑
    await runSeed(db!); // 再重跑
    const after = await countRows();
    expect(after).toEqual(before);
  });

  it('定位边 (source_id, plan_id) 重复 upsert = exists、不报错不重复', async () => {
    const vendor = (
      await db!
        .select({ id: schema.mrVendors.id })
        .from(schema.mrVendors)
        .where(eq(schema.mrVendors.normalizedName, SEED_VENDORS[0]!.normalizedName))
    )[0]!;
    const source = (
      await db!
        .select({ id: schema.mrSource.id })
        .from(schema.mrSource)
        .where(eq(schema.mrSource.vendorId, vendor.id))
    )[0]!;
    const plan = (
      await db!
        .select({ id: schema.mrPlans.id })
        .from(schema.mrPlans)
        .where(eq(schema.mrPlans.vendorId, vendor.id))
    )[0]!;

    // 首次（seed 已建过，故应 exists）。
    const a = await upsertPlanSource(db!, { sourceId: source.id, planId: plan.id });
    expect(a.outcome).toBe('exists');
    // 再次仍 exists，不报错。
    const b = await upsertPlanSource(db!, { sourceId: source.id, planId: plan.id });
    expect(b.outcome).toBe('exists');

    // 库内该边恰一行（DO NOTHING 不重复）。
    const rows = await db!
      .select()
      .from(schema.mrPlanSources)
      .where(
        and(
          eq(schema.mrPlanSources.sourceId, source.id),
          eq(schema.mrPlanSources.planId, plan.id),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
