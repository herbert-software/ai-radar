/**
 * 人工 dispose 面集成测试（task 7.3，**需本地 Postgres**，design D6）。
 *
 * 覆盖 spec「人工 dispose 最小面闭环」：
 * ① 并发收敛单行（CAS 幂等，复测 flag 写）；
 * ② reason 刷新（无 setWhere，翻标刷 reason）；
 * ③ resolved 重开 opened_at 重置；
 * ④ markChecked 后陈旧度不立即重标（resolve + 刷 last_checked 同事务）；
 * ⑤ **junction 触发的 plan flag `markChecked(plan)` 后刷 child 行 last_checked、不被重打标**。
 *
 * 不触网/不触 LLM；缺 DATABASE_URL 时自动跳过。用唯一前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, like, or } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { resolveFlag, setReviewFlag } = await import('../../write/flag.js');
const { listPendingFlags, markChecked } = await import('../dispose.js');
const { runStaleness } = await import('../staleness.js');

const PREFIX = 'mr-dispose-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

/** 远古时刻（保证落在任何阈值之外，模拟陈旧）。 */
const OLD = new Date('2000-01-01T00:00:00Z');

async function cleanup() {
  if (!db) return;
  const plans = await db
    .select({ id: schema.mrPlans.id })
    .from(schema.mrPlans)
    .where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  const sources = await db
    .select({ id: schema.mrSource.id })
    .from(schema.mrSource)
    .where(like(schema.mrSource.sourceUrl, `${PREFIX}%`));
  const generatedTargetIds = [...plans.map((p) => p.id), ...sources.map((s) => s.id)];
  const directPrefixMatch = like(schema.mrReviewFlag.targetId, `${PREFIX}%`);
  await db.delete(schema.mrReviewFlag).where(
    generatedTargetIds.length > 0
      ? or(directPrefixMatch, inArray(schema.mrReviewFlag.targetId, generatedTargetIds))
      : directPrefixMatch,
  );
  await db.delete(schema.mrPlanModels).where(like(schema.mrPlanModels.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanLimits).where(like(schema.mrPlanLimits.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanClients).where(like(schema.mrPlanClients.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrModels).where(like(schema.mrModels.family, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

async function flagRows(targetId: string) {
  return db!.select().from(schema.mrReviewFlag).where(eq(schema.mrReviewFlag.targetId, targetId));
}

/** 建一个 vendor + plan + 一行 child junction（model + plan_model），全部 last_checked 设为远古。 */
async function makeStalePlanWithJunction(suffix: string): Promise<string> {
  const [v] = await db!
    .insert(schema.mrVendors)
    .values({ normalizedName: `${PREFIX}v-${suffix}`, name: `V ${suffix}` })
    .returning();
  const [plan] = await db!
    .insert(schema.mrPlans)
    .values({
      vendorId: v!.id,
      name: `${PREFIX}plan-${suffix}`,
      category: 'coding_plan',
      currentPrice: '20.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-${suffix}`,
      lastChecked: OLD,
      sourceConfidence: 'official_pricing',
    })
    .returning();
  const [model] = await db!
    .insert(schema.mrModels)
    .values({ vendorId: v!.id, family: `${PREFIX}fam-${suffix}`, version: 'v1' })
    .returning();
  await db!.insert(schema.mrPlanModels).values({
    planId: plan!.id,
    modelId: model!.id,
    sourceUrl: `${PREFIX}src-${suffix}`,
    lastChecked: OLD,
    sourceConfidence: 'community',
  });
  return plan!.id;
}

describeIfDb('7.3 flag 翻转 + dispose', () => {
  it('并发收敛单行 + reason 刷新', async () => {
    const targetId = `${PREFIX}concurrent`;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        setReviewFlag(db!, { targetType: 'plan', targetId }, `r${i}`),
      ),
    );
    let r = await flagRows(targetId);
    expect(r).toHaveLength(1);

    await setReviewFlag(db!, { targetType: 'plan', targetId }, 'latest');
    r = await flagRows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.reason).toBe('latest');
  });

  it('resolved 重开 opened_at 重置', async () => {
    const targetId = `${PREFIX}reopen`;
    await setReviewFlag(db!, { targetType: 'source', targetId }, '首次');
    await markChecked(db!, { targetType: 'source', targetId }); // resolve
    // 手动把 opened_at 塞到过去，便于断言重开刷为 now。
    await db!
      .update(schema.mrReviewFlag)
      .set({ openedAt: OLD })
      .where(eq(schema.mrReviewFlag.targetId, targetId));

    await setReviewFlag(db!, { targetType: 'source', targetId }, '重开');
    const r = await flagRows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');
    expect(r[0]!.resolvedAt).toBeNull();
    expect(r[0]!.openedAt!.getFullYear()).toBeGreaterThan(2000);
  });

  it('resolveFlag expectedOpenedAt mismatch 返回 0 且不清 newer pending flag', async () => {
    const targetId = `${PREFIX}generation-mismatch`;
    await setReviewFlag(db!, { targetType: 'plan', targetId }, '旧触发');
    // 经 listPendingFlags 拿 full-precision text（精度安全，配 resolveFlag 的 text↔text 比）。
    const oldOpenedAtText = (await listPendingFlags(db!, { targetType: 'plan' })).find(
      (f) => f.targetId === targetId,
    )!.openedAtText;
    const first = (await flagRows(targetId))[0]!;
    const newerOpenedAt = new Date(first.openedAt!.getTime() + 60_000);
    await db!
      .update(schema.mrReviewFlag)
      .set({ openedAt: newerOpenedAt, reason: '新触发', status: 'pending', resolvedAt: null })
      .where(eq(schema.mrReviewFlag.targetId, targetId));

    const affected = await resolveFlag(
      db!,
      { targetType: 'plan', targetId },
      { expectedOpenedAt: oldOpenedAtText },
    );

    const r = await flagRows(targetId);
    expect(affected).toBe(0);
    expect(r[0]!.status).toBe('pending');
    expect(r[0]!.reason).toBe('新触发');
    expect(r[0]!.openedAt!.getTime()).toBe(newerOpenedAt.getTime());
  });

  it('markChecked 传旧 expectedOpenedAt（人在 list 后 flag 被重开）→ not-resolved 且不清新标', async () => {
    const targetId = `${PREFIX}gen-gate-markchecked`;
    await setReviewFlag(db!, { targetType: 'plan', targetId }, '旧触发');
    // 人在 listPendingFlags 时见到的 opened_at（full-precision text）。
    const staleOpenedAtText = (await listPendingFlags(db!, { targetType: 'plan' })).find(
      (f) => f.targetId === targetId,
    )!.openedAtText;

    // list 之后、markChecked 之前：该 flag 被重开（setReviewFlag 使 opened_at 前进到 now）。
    await setReviewFlag(db!, { targetType: 'plan', targetId }, '新触发');

    const result = await markChecked(
      db!,
      { targetType: 'plan', targetId },
      { expectedOpenedAt: staleOpenedAtText },
    );

    expect(result).toEqual({ outcome: 'not-resolved' });
    const r = await flagRows(targetId);
    // 新 pending 标未被旧复核误清。
    expect(r[0]!.status).toBe('pending');
    expect(r[0]!.reason).toBe('新触发');
  });

  it('markChecked 无 pending flag：返回 not-resolved 且不更新 last_checked', async () => {
    const suffix = 'no-pending';
    const [v] = await db!
      .insert(schema.mrVendors)
      .values({ normalizedName: `${PREFIX}v-${suffix}`, name: `V ${suffix}` })
      .returning();
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-${suffix}`,
        vendorId: v!.id,
        fetchStrategy: 'http',
        lastChecked: OLD,
      })
      .returning();

    const result = await markChecked(db!, { targetType: 'source', targetId: src!.id });
    const [after] = await db!
      .select()
      .from(schema.mrSource)
      .where(eq(schema.mrSource.id, src!.id));

    expect(result).toEqual({ outcome: 'not-resolved' });
    expect(after!.lastChecked!.getTime()).toBe(OLD.getTime());
    expect(await flagRows(src!.id)).toHaveLength(0);
  });

  it('markChecked(source) 后陈旧度不立即重标', async () => {
    const suffix = 'src-fresh';
    const [v] = await db!
      .insert(schema.mrVendors)
      .values({ normalizedName: `${PREFIX}v-${suffix}`, name: `V ${suffix}` })
      .returning();
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-${suffix}`,
        vendorId: v!.id,
        fetchStrategy: 'http',
        lastChecked: OLD, // 远古 → 陈旧
      })
      .returning();

    // 陈旧度先打标。
    await runStaleness(db!, { thresholdDays: 30 });
    let r = await flagRows(src!.id);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');

    // 人工 markChecked：resolve + 刷 last_checked=now（同事务）。
    const result = await markChecked(db!, { targetType: 'source', targetId: src!.id });
    expect(result).toEqual({ outcome: 'checked' });
    r = await flagRows(src!.id);
    expect(r[0]!.status).toBe('resolved');

    // 再跑陈旧度：last_checked 已新 → 不重开。
    await runStaleness(db!, { thresholdDays: 30 });
    r = await flagRows(src!.id);
    expect(r[0]!.status).toBe('resolved');
  });

  it('junction 触发的 plan flag markChecked(plan) 后刷 child、不被重打标', async () => {
    const planId = await makeStalePlanWithJunction('junc');

    // 陈旧 child（plan_model last_checked=远古）→ 陈旧度给所属 plan 打标。
    await runStaleness(db!, { thresholdDays: 30 });
    let r = await flagRows(planId);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');

    // markChecked(plan)：刷 mr_plans + 全部 child（含 plan_model）last_checked=now。
    const result = await markChecked(db!, { targetType: 'plan', targetId: planId });
    expect(result).toEqual({ outcome: 'checked' });
    r = await flagRows(planId);
    expect(r[0]!.status).toBe('resolved');

    // 断言 child 行 last_checked 已被刷新（不再是远古）。
    const pm = await db!
      .select()
      .from(schema.mrPlanModels)
      .where(eq(schema.mrPlanModels.planId, planId));
    expect(pm[0]!.lastChecked!.getFullYear()).toBeGreaterThan(2000);

    // 再跑陈旧度：child 已新 → plan flag 不被重打标，仍 resolved。
    await runStaleness(db!, { thresholdDays: 30 });
    r = await flagRows(planId);
    expect(r[0]!.status).toBe('resolved');
  });

  it('listPendingFlags 按 target_type 过滤 + 默认列全部 pending', async () => {
    const planTarget = `${PREFIX}list-plan`;
    const srcTarget = `${PREFIX}list-src`;
    await setReviewFlag(db!, { targetType: 'plan', targetId: planTarget }, 'p');
    await setReviewFlag(db!, { targetType: 'source', targetId: srcTarget }, 's');

    const onlyPlans = await listPendingFlags(db!, { targetType: 'plan' });
    const ids = onlyPlans.map((f) => f.targetId);
    expect(ids).toContain(planTarget);
    expect(ids).not.toContain(srcTarget);

    // olderThanMs：刚打的标 opened_at≈now，olderThanMs 大 → 不命中。
    const veryOld = await listPendingFlags(db!, {
      targetType: 'plan',
      olderThanMs: 365 * 86_400_000,
    });
    expect(veryOld.map((f) => f.targetId)).not.toContain(planTarget);
  });

  it('markChecked(plan) 与陈旧度刷新在同事务原子（resolve 行存在即 last_checked 已刷）', async () => {
    const planId = await makeStalePlanWithJunction('atomic');
    await setReviewFlag(db!, { targetType: 'plan', targetId: planId }, '触发');
    const result = await markChecked(db!, { targetType: 'plan', targetId: planId });
    expect(result).toEqual({ outcome: 'checked' });

    const r = await flagRows(planId);
    expect(r[0]!.status).toBe('resolved');
    const plan = await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId));
    expect(plan[0]!.lastChecked!.getTime()).toBeGreaterThan(OLD.getTime());
    // 确保 sql now() 路径生效（last_checked 接近当前）。
    expect(Date.now() - plan[0]!.lastChecked!.getTime()).toBeLessThan(60_000);
  });
});
