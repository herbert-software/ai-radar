/**
 * 桶2 Coding Plan 数据策展往返契约（task 1.5，**需本地 Postgres**，design D5）。
 *
 * 覆盖 spec「桶2数据策展只录已核价格、允许零已核价」+「已核价格写入必须带官方 provenance」：
 * ① **未核占位**：upsertPlan 录 needs_login_recheck + NULL 价 → current_price/currency NULL、**不写 mr_price_history**；
 * ② **已核往返**：经授权改价入口 recordPriceChange(official_pricing) 写真价 → 追加 history + current 刷新；
 * ③ **未核拒写**：recordPriceChange 带非官方 confidence（needs_login_recheck）发 SQL 前被拒、**不落 history**
 *    （confidence-must-be-official，task 1.6 双层兜的改价侧）。
 *
 * 结构性录入完成即算 1.4/1.5 验收，不因缺价判失败——本测试不依赖 seed 真价，用 PREFIX 自造行隔离。
 * 不触网 / 不触 LLM；缺 DATABASE_URL 自动跳过。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, like } from 'drizzle-orm';
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

const { recordPriceChange } = await import('../record-price-change.js');
const { upsertVendor, upsertPlan } = await import('../upsert.js');

const PREFIX = 'mr-b2-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

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

async function makePlaceholderPlan(suffix: string): Promise<string> {
  const v = await upsertVendor(db!, {
    normalizedName: `${PREFIX}v-${suffix}`,
    name: `V ${suffix}`,
  });
  const plan = await upsertPlan(db!, {
    vendorId: v.id,
    name: `${PREFIX}coding-plan-${suffix}`,
    category: 'coding_plan',
    currentPrice: null,
    currency: null,
    sourceUrl: `${PREFIX}src-${suffix}`,
    sourceConfidence: 'needs_login_recheck',
  });
  return (plan as { id: string }).id;
}

async function historyCount(planId: string): Promise<number> {
  const h = await db!
    .select({ id: schema.mrPriceHistory.id })
    .from(schema.mrPriceHistory)
    .where(eq(schema.mrPriceHistory.planId, planId));
  return h.length;
}

describeIfDb('1.5 桶2 数据策展往返', () => {
  it('未核占位：needs_login_recheck + NULL 价 → current NULL、不写 history', async () => {
    const planId = await makePlaceholderPlan('placeholder');
    const row = (
      await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId))
    )[0]!;
    expect(row.currentPrice).toBeNull();
    expect(row.currency).toBeNull();
    expect(row.sourceConfidence).toBe('needs_login_recheck');
    expect(await historyCount(planId)).toBe(0);
  });

  it('已核往返：recordPriceChange(official_pricing) → 追加 history + 刷 current', async () => {
    const planId = await makePlaceholderPlan('verified');
    const out = await recordPriceChange(
      {
        planId,
        newValue: 40,
        currency: 'CNY',
        provenance: { sourceUrl: `${PREFIX}src-verified`, sourceConfidence: 'official_pricing' },
      },
      db!,
    );
    expect(out.outcome).toBe('appended');
    expect(await historyCount(planId)).toBe(1);

    const row = (
      await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId))
    )[0]!;
    expect(Number(row.currentPrice)).toBe(40);
    expect(row.currency).toBe('CNY');
    expect(row.sourceConfidence).toBe('official_pricing');
  });

  it('未核拒写：recordPriceChange 带 needs_login_recheck 发 SQL 前被拒、不落 history', async () => {
    const planId = await makePlaceholderPlan('rejected');
    await expect(
      recordPriceChange(
        {
          planId,
          newValue: 40,
          currency: 'CNY',
          provenance: {
            sourceUrl: `${PREFIX}src-rejected`,
            sourceConfidence: 'needs_login_recheck',
          },
        },
        db!,
      ),
    ).rejects.toThrow();
    // 不落 history、current 仍 NULL。
    expect(await historyCount(planId)).toBe(0);
    const row = (
      await db!.select().from(schema.mrPlans).where(eq(schema.mrPlans.id, planId))
    )[0]!;
    expect(row.currentPrice).toBeNull();
  });
});
