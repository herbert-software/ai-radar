/**
 * compareAndUpdateFingerprint 集成测试（task 7.5，**需本地 Postgres**，缺 DATABASE_URL 自动跳过）。
 *
 * 覆盖 spec「三档抓取仅做变更检测、检测器原子防 stale-retry、绝不改事实」(design D7)：
 * ① 指纹真变 → 更新 fingerprint/last_checked + 给覆盖 plan 打 pending flag（事实值不变）；
 * ② stale 重试（抓到与已更新 fingerprint 相同）→ 无变化 → 不打标（不重开已 resolve 的 flag）；
 * ③ 定位空集合（源无关联 plan）→ 给 source 自身打 target_type='source' flag（页面变动不被吞）。
 *
 * 不触网/不触 LLM。唯一前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { compareAndUpdateFingerprint } = await import('../fingerprint-store.js');
const { resolveFlag } = await import('../flag.js');

const PREFIX = 'mr-fp-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.targetId, `${PREFIX}%`));
  await db.delete(schema.mrPlanSources).where(like(schema.mrPlanSources.sourceId, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.id, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.id, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

async function flagFor(targetType: string, targetId: string) {
  const rows = await db!
    .select()
    .from(schema.mrReviewFlag)
    .where(
      and(
        eq(schema.mrReviewFlag.targetType, targetType),
        eq(schema.mrReviewFlag.targetId, targetId),
      ),
    );
  return rows[0] ?? null;
}

describeIfDb('compareAndUpdateFingerprint', () => {
  it('指纹真变 → 更新指纹 + 给覆盖 plan 打标', async () => {
    const sourceId = `${PREFIX}src-a`;
    const planId = `${PREFIX}plan-a`;
    // seed: plan + source + 定位边。
    await db!.insert(schema.mrPlans).values({
      id: planId,
      vendorId: `${PREFIX}vendor`,
      name: `${PREFIX}Plan A`,
      category: 'coding_plan',
      currentPrice: '20.00',
      currency: 'USD',
      sourceUrl: 'https://openai.com/p',
      lastChecked: new Date(),
      sourceConfidence: 'official',
    });
    await db!.insert(schema.mrSource).values({
      id: sourceId,
      sourceUrl: 'https://openai.com/p',
      vendorId: `${PREFIX}vendor`,
      fetchStrategy: 'http',
      contentFingerprint: 'old-fp',
    });
    await db!.insert(schema.mrPlanSources).values({ sourceId, planId });

    const out = await compareAndUpdateFingerprint(db!, sourceId, 'new-fp', 'page changed');
    expect(out).toEqual({ outcome: 'changed', flaggedPlans: 1 });

    // 指纹更新 + plan 打 pending flag。
    const src = (
      await db!.select().from(schema.mrSource).where(eq(schema.mrSource.id, sourceId))
    )[0]!;
    expect(src.contentFingerprint).toBe('new-fp');
    expect(src.lastChecked).not.toBeNull();
    const flag = await flagFor('plan', planId);
    expect(flag?.status).toBe('pending');

    // 事实不变：current_price 仍 20.00。
    const plan = (
      await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId))
    )[0]!;
    expect(Number(plan.currentPrice)).toBe(20);
  });

  it('stale 重试（指纹相同）→ 不打标（不重开已 resolve 的 flag）', async () => {
    const sourceId = `${PREFIX}src-b`;
    const planId = `${PREFIX}plan-b`;
    await db!.insert(schema.mrPlans).values({
      id: planId,
      vendorId: `${PREFIX}vendor`,
      name: `${PREFIX}Plan B`,
      category: 'coding_plan',
      sourceUrl: 'https://openai.com/b',
      lastChecked: new Date(),
      sourceConfidence: 'official',
    });
    await db!.insert(schema.mrSource).values({
      id: sourceId,
      sourceUrl: 'https://openai.com/b',
      vendorId: `${PREFIX}vendor`,
      fetchStrategy: 'http',
      contentFingerprint: 'fp-b',
    });
    await db!.insert(schema.mrPlanSources).values({ sourceId, planId });

    // 首次真变打标，然后人工 resolve。
    await compareAndUpdateFingerprint(db!, sourceId, 'fp-b-2', 'changed');
    await resolveFlag(db!, { targetType: 'plan', targetId: planId });
    expect((await flagFor('plan', planId))?.status).toBe('resolved');

    // stale 重试：抓到与已更新 fingerprint 相同 → unchanged → 不打标，flag 仍 resolved。
    const out = await compareAndUpdateFingerprint(db!, sourceId, 'fp-b-2', 'stale retry');
    expect(out).toEqual({ outcome: 'unchanged' });
    expect((await flagFor('plan', planId))?.status).toBe('resolved');
  });

  it('定位空集合 → 给 source 自身打标', async () => {
    const sourceId = `${PREFIX}src-c`;
    await db!.insert(schema.mrSource).values({
      id: sourceId,
      sourceUrl: 'https://openai.com/c',
      vendorId: `${PREFIX}vendor`,
      fetchStrategy: 'http',
      contentFingerprint: 'fp-c',
    });
    // 无 mr_plan_sources 边。
    const out = await compareAndUpdateFingerprint(db!, sourceId, 'fp-c-2', 'changed');
    expect(out).toEqual({ outcome: 'changed-source-flag' });
    expect((await flagFor('source', sourceId))?.status).toBe('pending');
  });

  it('源不存在 → source-missing（不 NPE）', async () => {
    const out = await compareAndUpdateFingerprint(db!, `${PREFIX}nope`, 'x', 'changed');
    expect(out).toEqual({ outcome: 'source-missing' });
  });
});
