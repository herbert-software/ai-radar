/**
 * 改价契约集成测试（task 7.2，**需本地 Postgres**，design D4）。
 *
 * 覆盖 spec「单一改价入口，current=latest 从 history 推导」：
 * ① 真追加才动 current（带 old_value=改前 current）且一并刷 source_* 与 last_checked；
 * ② 无价变捷径：同价同币仅刷 provenance/last_checked、**不 append no-op 价行**；
 *    `current IS NULL` 占位首个真价仍走真追加（不被 `Number(null)→0` 误判跳过）；
 * ③ 同价不同字面（`45` vs `'45.00'`）判幂等不打 conflict；
 * ④ 同刻不同价不脱钩（DO NOTHING、不动 current、打 price_history_conflict flag）；
 * ⑤ 同额异币种=元组异打 conflict；
 * ⑥ clock_timestamp 下 latest history 与 current 不倒挂（注入长外层 tx + 锁等待后改价）；
 * ⑦ append-only：grep 守 recordPriceChange 模块外无 .update/.delete(mrPriceHistory)（在本文件末尾断言）。
 *
 * 同刻冲突（④⑤）clock_timestamp 下天然不可复现，故**预置同 changed_at 的既有 history 行**，再驱动
 * **生产 `_recordPriceChangeTx`** 并钉死其 `nowSql` 注入缝隙为同一固定时戳（撞 ON CONFLICT(plan_id, changed_at)）——
 * 直接覆盖生产同刻分支（不再用测试内手抄副本），断言 current 不动 + price_history_conflict flag。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, like, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// recordPriceChange/upsertPlan post-commit 经 runSnapshotRebuild 调真 publisher（连 env.REDIS_URL）。
// mock 成 no-op，守「测试绝不连真 Redis」红线、并免 Redis-down 时每次 publish 阻塞 ~1s（仿 cache.test.ts）。
vi.mock('../../snapshot/invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const { recordPriceChange, _recordPriceChangeTx } = await import(
  '../record-price-change.js'
);
const { upsertVendor, upsertPlan } = await import('../upsert.js');

const PREFIX = 'mr-price-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const PROV = (n: string) => ({
  sourceUrl: `${PREFIX}prov-${n}`,
  sourceConfidence: 'official_pricing',
});

async function makePlan(
  suffix: string,
  currentPrice: string | null,
  currency: string | null,
): Promise<string> {
  const v = await upsertVendor(db!, {
    normalizedName: `${PREFIX}v-${suffix}`,
    name: `V ${suffix}`,
  });
  const plan = await upsertPlan(db!, {
    vendorId: v.id,
    name: `${PREFIX}plan-${suffix}`,
    category: 'coding_plan',
    currentPrice,
    currency,
    sourceUrl: `${PREFIX}src-${suffix}`,
    sourceConfidence: currentPrice == null ? 'needs_login_recheck' : 'official_pricing',
  });
  return (plan as { id: string }).id;
}

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.targetId, `${PREFIX}%`));
  await db.delete(schema.mrPriceHistory).where(like(schema.mrPriceHistory.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

async function history(planId: string) {
  return db!
    .select()
    .from(schema.mrPriceHistory)
    .where(eq(schema.mrPriceHistory.planId, planId))
    .orderBy(sql`${schema.mrPriceHistory.changedAt} asc`);
}
async function planRow(planId: string) {
  const r = await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId));
  return r[0]!;
}

describeIfDb('7.2 改价契约', () => {
  it('真追加才动 current（old_value=改前 + 同事务刷 source_*/last_checked）', async () => {
    const planId = await makePlan('append', '30.00', 'USD');
    const before = await planRow(planId);
    const out = await recordPriceChange(
      { planId, newValue: 45, currency: 'USD', provenance: PROV('append') },
      db!,
    );
    expect(out.outcome).toBe('appended');

    const h = await history(planId);
    expect(h).toHaveLength(1);
    expect(Number(h[0]!.newValue)).toBe(45);
    expect(Number(h[0]!.oldValue)).toBe(30); // old_value = 改前 current

    const after = await planRow(planId);
    expect(Number(after.currentPrice)).toBe(45);
    expect(after.sourceUrl).toBe(`${PREFIX}prov-append`); // provenance 一并刷
    expect(after.lastChecked.getTime()).toBeGreaterThanOrEqual(before.lastChecked.getTime());
  });

  it('无价变捷径：同价同币仅刷 provenance/last_checked、不 append no-op 价行', async () => {
    const planId = await makePlan('noop', '45.00', 'USD');
    const out = await recordPriceChange(
      {
        planId,
        newValue: 45,
        currency: 'USD',
        provenance: { sourceUrl: `${PREFIX}prov-noop-NEW`, sourceConfidence: 'official_doc' },
      },
      db!,
    );
    expect(out.outcome).toBe('noop-refreshed');
    const h = await history(planId);
    expect(h).toHaveLength(0); // 不 append no-op 价行
    const after = await planRow(planId);
    expect(after.sourceUrl).toBe(`${PREFIX}prov-noop-NEW`); // provenance 刷新
    expect(after.sourceConfidence).toBe('official_doc');
    expect(Number(after.currentPrice)).toBe(45); // current 不变
  });

  it('current IS NULL 占位首个真价走真追加（不被 Number(null)→0 误判跳过）', async () => {
    const planId = await makePlan('nullfirst', null, null);
    const out = await recordPriceChange(
      { planId, newValue: '0', currency: 'USD', provenance: PROV('nullfirst') },
      db!,
    );
    // 即便新价是 0（Number(0)===Number(null→0)），current IS NULL 也必须真追加。
    expect(out.outcome).toBe('appended');
    const h = await history(planId);
    expect(h).toHaveLength(1);
    expect(h[0]!.oldValue).toBeNull();
    const after = await planRow(planId);
    expect(Number(after.currentPrice)).toBe(0);
    expect(after.currency).toBe('USD');
  });

  it('同价不同字面（45 vs 当前 45.00）判幂等不打 conflict', async () => {
    const planId = await makePlan('literal', '45.00', 'USD');
    const out = await recordPriceChange(
      { planId, newValue: 45, currency: 'USD', provenance: PROV('literal') },
      db!,
    );
    expect(out.outcome).toBe('noop-refreshed'); // 数值归一判同，走捷径
    const h = await history(planId);
    expect(h).toHaveLength(0);
    const flags = await db!
      .select()
      .from(schema.mrReviewFlag)
      .where(eq(schema.mrReviewFlag.targetId, planId));
    expect(flags).toHaveLength(0); // 不打 conflict
  });

  it('同刻不同价不脱钩：DO NOTHING、不动 current、打 price_history_conflict flag', async () => {
    const planId = await makePlan('conflict', '40.00', 'USD');
    const fixed = new Date('2030-01-01T00:00:00Z');
    // 预置一条占住该 changed_at 的 history（new_value=40）。
    await db!.insert(schema.mrPriceHistory).values({
      planId,
      oldValue: null,
      newValue: '40.00',
      currency: 'USD',
      changedAt: fixed,
      sourceUrl: `${PREFIX}preset-conflict`,
      sourceConfidence: 'official_pricing',
    });
    // 在注入的事务里以**同一固定 changed_at**（nowSql 钉死）走生产 _recordPriceChangeTx：
    // 模拟同刻冲突分支（新价 45 异于既有 40，撞 ON CONFLICT(plan_id, changed_at)）。
    const out = await db!.transaction((tx) =>
      _recordPriceChangeTx(
        tx,
        { planId, newValue: 45, currency: 'USD', provenance: PROV('conflict') },
        sql`${fixed.toISOString()}::timestamptz`,
      ),
    );
    expect(out.outcome).toBe('history-conflict');

    // history 行不变（DO NOTHING）：仍只 1 行、值仍 40。
    const h = await history(planId);
    expect(h).toHaveLength(1);
    expect(Number(h[0]!.newValue)).toBe(40);
    // current 不更新为 45。
    expect(Number((await planRow(planId)).currentPrice)).toBe(40);
    // 打了 price_history_conflict flag。
    const flags = await db!
      .select()
      .from(schema.mrReviewFlag)
      .where(eq(schema.mrReviewFlag.targetId, planId));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.reason).toContain('price_history_conflict');
  });

  it('同额异币种=元组异打 conflict、不更新 current', async () => {
    const planId = await makePlan('xcurrency', '45.00', 'CNY');
    const fixed = new Date('2031-01-01T00:00:00Z');
    await db!.insert(schema.mrPriceHistory).values({
      planId,
      oldValue: null,
      newValue: '45.00',
      currency: 'CNY',
      changedAt: fixed,
      sourceUrl: `${PREFIX}preset-xcur`,
      sourceConfidence: 'official_pricing',
    });
    // 同 changed_at（nowSql 钉死）、同额 45 但异币种 USD → 元组异。
    const out = await db!.transaction((tx) =>
      _recordPriceChangeTx(
        tx,
        { planId, newValue: 45, currency: 'USD', provenance: PROV('xcur') },
        sql`${fixed.toISOString()}::timestamptz`,
      ),
    );
    expect(out.outcome).toBe('history-conflict');
    expect((await planRow(planId)).currency).toBe('CNY'); // current 不动
    const flags = await db!
      .select()
      .from(schema.mrReviewFlag)
      .where(eq(schema.mrReviewFlag.targetId, planId));
    expect(flags).toHaveLength(1);
  });

  it('clock_timestamp 下 latest history 与 current 不倒挂（注入长 tx + 锁等待后改价）', async () => {
    const planId = await makePlan('clock', '10.00', 'USD');

    // 并发竞争者：先在另一事务里锁住该 plan 行并 sleep，迫使主改价等待行锁后才拿到更晚 clock_timestamp。
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((r) => (releaseHolder = r));
    const holderStarted = new Promise<void>((r) => {
      void db!.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.mrPlans)
          .where(eq(schema.mrPlans.id, planId))
          .for('update');
        r(); // 已持锁
        await holderReleased; // 持锁直到主测放行
      });
    });
    await holderStarted;

    // 主改价：注入长外层 tx，FOR UPDATE 会阻塞在 holder 的锁上；放行后才拿锁、clock_timestamp 锁后生成。
    const changePromise = db!.transaction((tx) =>
      _recordPriceChangeTx(tx, {
        planId,
        newValue: 25,
        currency: 'USD',
        provenance: PROV('clock'),
      }),
    );
    // 短暂让主改价进入锁等待，再放行 holder。
    await new Promise((r) => setTimeout(r, 150));
    releaseHolder();
    const out = await changePromise;
    expect(out.outcome).toBe('appended');

    // latest history（MAX changed_at）与 current 一致，不倒挂。
    const h = await history(planId);
    const latest = h[h.length - 1]!;
    const p = await planRow(planId);
    expect(Number(latest.newValue)).toBe(Number(p.currentPrice));
    expect(Number(p.currentPrice)).toBe(25);
  });
});

/** append-only 静态守卫（task 7.2 grep）：recordPriceChange 模块外无 .update/.delete(mrPriceHistory)。 */
describe('7.2 append-only 静态守卫', () => {
  it('recordPriceChange 模块只 INSERT，全仓 mr 路径无 .update/.delete(mrPriceHistory)', () => {
    // 扫 upsert.ts / record-price-change.ts 源：禁出现对 mrPriceHistory 的 update/delete 调用。
    for (const f of [
      'src/mr/ingest/record-price-change.ts',
      'src/mr/ingest/upsert.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\.update\(\s*mrPriceHistory/);
      expect(src).not.toMatch(/\.delete\(\s*mrPriceHistory/);
    }
  });
});
