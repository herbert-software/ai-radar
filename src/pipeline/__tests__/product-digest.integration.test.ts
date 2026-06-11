/**
 * 每日产品发现推送集成测试（任务 8.2，product-discovery「每日产品发现推送」不变量）。
 * 需本地 Postgres（compose 起的库）。mock 发送器断言状态机，不依赖真实 Telegram / Product Hunt。
 * 用内存 Redis 桩驱动 per-channel 单例锁，候选/塌缩走真实 DB。
 *
 * 覆盖场景（spec product-discovery）：
 * - 同天同产品同通道不重复推（UNIQUE(target_type='product',target_id,channel,push_date) 冲突跳过）。
 * - 已推过产品跨天不再重推（候选窗口「从未以该 channel success」）。
 * - 冲突态产品（merge_conflict）排除出候选（不因各 product_id「从未 success」各推一次）。
 * - 产品推送与事件日报 target_type 不同互不挤占（event 已推不抑制 product 待发，反之亦然）。
 *
 * 缺 DATABASE_URL 时本套件自动跳过；用唯一 name/product_id 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { MessageSender } from '../../push/dispatcher.js';

// 注入占位 env 让无真实凭据也能 import config/env（启动期校验）；DATABASE_URL 仍由 .env/CI 注入。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runProductDigest, selectProductCandidates } = await import(
  '../product-digest.js'
);
import type { ProductLockRedis } from '../product-digest.js';

const databaseUrl = process.env.DATABASE_URL;
const canRun = Boolean(databaseUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const PREFIX = `pd-itest-${process.pid}-`;
// 专属 push_date（远离真实运行日）+ product_id/name 前缀隔离本套件造的行。
const NOW_DAY1 = new Date('2099-03-01T04:00:00Z'); // 上海 2099-03-01 12:00
const PUSH_DATE_1 = '2099-03-01';
const NOW_DAY2 = new Date('2099-03-02T04:00:00Z'); // 上海 2099-03-02 12:00

/** 内存 Redis 桩：实现 SET NX PX + eval(release)，驱动 per-channel 单例锁（不依赖真实 Redis）。 */
function memRedis(): ProductLockRedis {
  const store = new Map<string, string>();
  return {
    async set(key, value, _mode, _ttlMs, _nx) {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(_script, _numKeys, key, token) {
      // RELEASE：核对令牌再删。
      if (store.get(String(key)) === String(token)) {
        store.delete(String(key));
        return 1;
      }
      return 0;
    },
  };
}

/** 成功发送器：记录调用次数。 */
function okSender(): MessageSender & { calls: number } {
  const s = {
    calls: 0,
    async send() {
      s.calls += 1;
    },
  };
  return s;
}

/** 插入一条 ai_products，返回 product_id（用前缀 + 显式 product_id 隔离）。 */
async function seedProduct(args: {
  suffix: string;
  name?: string;
  canonicalDomain?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<string> {
  const productId = `${PREFIX}${args.suffix}`;
  await pool!.query(
    `INSERT INTO ai_products (product_id, name, canonical_domain, last_seen_at, metadata)
     VALUES ($1, $2, $3, now(), $4::jsonb)`,
    [
      productId,
      args.name ?? `${PREFIX}${args.suffix}-name`,
      args.canonicalDomain ?? null,
      args.metadata ? JSON.stringify(args.metadata) : null,
    ],
  );
  return productId;
}

async function fetchPushRows(channel: string, pushDate: string) {
  const { rows } = await pool!.query<{
    target_id: string;
    status: string;
    push_date: string;
  }>(
    `SELECT target_id, status, push_date::text AS push_date
       FROM push_records
      WHERE target_type = 'product' AND channel = $1 AND push_date = $2
        AND target_id LIKE $3
      ORDER BY target_id`,
    [channel, pushDate, `${PREFIX}%`],
  );
  return rows;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE product_id LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!canRun)('每日产品发现推送（productDiscovery push）', () => {
  it('同天同产品同通道不重复推（UNIQUE 冲突跳过）', async () => {
    const pid = await seedProduct({ suffix: 'a1' });

    // 首推（telegram）：候选含该产品 → 整批 success。
    const s1 = okSender();
    const r1 = await runProductDigest({
      now: NOW_DAY1,
      dbh: db!,
      skipCollectAndCollapse: true,
      channels: ['telegram'],
      senders: { telegram: s1 },
      lock: { redis: memRedis() },
    });
    const tg1 = r1.channels.find((c) => c.channel === 'telegram')!;
    expect(tg1.outcome).toBe('sent');
    expect(tg1.productIds).toContain(pid);
    expect(s1.calls).toBe(1);

    const rows = await fetchPushRows('telegram', PUSH_DATE_1);
    expect(rows.find((r) => r.target_id === pid)?.status).toBe('success');

    // 同天同通道重跑：该产品今日已 success → 待发集合空 → 不重发（UNIQUE 兜底，dispatcher skipped）。
    const s2 = okSender();
    const r2 = await runProductDigest({
      now: NOW_DAY1,
      dbh: db!,
      skipCollectAndCollapse: true,
      channels: ['telegram'],
      senders: { telegram: s2 },
      lock: { redis: memRedis() },
    });
    const tg2 = r2.channels.find((c) => c.channel === 'telegram')!;
    expect(tg2.outcome).toBe('skipped');
    expect(s2.calls).toBe(0);

    // 仍只有一行（四元组唯一）。
    const { rows: cnt } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM push_records
        WHERE target_type='product' AND channel='telegram' AND push_date=$1 AND target_id=$2`,
      [PUSH_DATE_1, pid],
    );
    expect(Number(cnt[0]!.n)).toBe(1);
  });

  it('已推过产品跨天不再重推（候选窗口「从未以该 channel success」）', async () => {
    const pid = await seedProduct({ suffix: 'b1' });

    // Day1 推送 success。
    const r1 = await runProductDigest({
      now: NOW_DAY1,
      dbh: db!,
      skipCollectAndCollapse: true,
      channels: ['telegram'],
      senders: { telegram: okSender() },
      lock: { redis: memRedis() },
    });
    expect(r1.channels[0]!.productIds).toContain(pid);

    // 模拟 PH 持续上榜：last_seen_at 刷新到「今天」。
    await pool!.query(`UPDATE ai_products SET last_seen_at = now() WHERE product_id = $1`, [
      pid,
    ]);

    // Day2 候选窗口：该产品曾 success（任一 push_date）→ 不再进入候选（跨天不重推）。
    const day2Candidates = await selectProductCandidates('telegram', db!);
    expect(day2Candidates.map((c) => c.eventId)).not.toContain(pid);

    // Day2 跑一次：该产品不在候选 → 不会因新 push_date 重推。
    await runProductDigest({
      now: NOW_DAY2,
      dbh: db!,
      skipCollectAndCollapse: true,
      channels: ['telegram'],
      senders: { telegram: okSender() },
      lock: { redis: memRedis() },
    });
    const day2Rows = await fetchPushRows('telegram', '2099-03-02');
    expect(day2Rows.find((r) => r.target_id === pid)).toBeUndefined();
  });

  it('冲突态产品（merge_conflict）排除出推送候选', async () => {
    // 两行同一真实产品散为多 product_id，各标 merge_conflict（模拟塌缩多键命中多行冲突）。
    const pidX = await seedProduct({
      suffix: 'conflict-x',
      metadata: { merge_conflict: { conflict_with: [`${PREFIX}conflict-y`], detected_at: 'now' } },
    });
    const pidY = await seedProduct({
      suffix: 'conflict-y',
      metadata: { merge_conflict: { conflict_with: [`${PREFIX}conflict-x`], detected_at: 'now' } },
    });
    // 一个干净产品作对照（应进入候选）。
    const pidClean = await seedProduct({ suffix: 'conflict-clean' });

    const candidates = await selectProductCandidates('telegram', db!);
    const ids = candidates.map((c) => c.eventId);
    expect(ids).not.toContain(pidX);
    expect(ids).not.toContain(pidY);
    expect(ids).toContain(pidClean);

    // 跑推送：冲突两行不被推（无 success 行）；干净产品被推。
    const r = await runProductDigest({
      now: NOW_DAY1,
      dbh: db!,
      skipCollectAndCollapse: true,
      channels: ['telegram'],
      senders: { telegram: okSender() },
      lock: { redis: memRedis() },
    });
    expect(r.channels[0]!.productIds).toContain(pidClean);
    expect(r.channels[0]!.productIds).not.toContain(pidX);
    expect(r.channels[0]!.productIds).not.toContain(pidY);

    const rows = await fetchPushRows('telegram', PUSH_DATE_1);
    const byId = new Map(rows.map((r) => [r.target_id, r.status]));
    expect(byId.get(pidX)).toBeUndefined(); // 冲突行从未 INSERT 推送记录。
    expect(byId.get(pidY)).toBeUndefined();
    expect(byId.get(pidClean)).toBe('success');
  });

  it('产品推送与事件日报 target_type 不同互不挤占', async () => {
    // 一个 product_id 与一个同名 event_id（同 target_id 值但 target_type 不同）。
    const sharedId = `${PREFIX}shared-target`;
    await seedProduct({ suffix: 'shared-target' });

    // 先以 target_type='event' 在 telegram 写一条 success（模拟事件日报已推该 id）。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('event', $1, 'telegram', $2, 'success', now())`,
      [sharedId, PUSH_DATE_1],
    );

    // 产品候选不被 event 的 success 抑制（target_type 不同各自独立命名空间）。
    const candidates = await selectProductCandidates('telegram', db!);
    expect(candidates.map((c) => c.eventId)).toContain(sharedId);

    // 跑产品推送：该 product 仍被推（写 target_type='product' 行，不与 event 行冲突）。
    const r = await runProductDigest({
      now: NOW_DAY1,
      dbh: db!,
      skipCollectAndCollapse: true,
      channels: ['telegram'],
      senders: { telegram: okSender() },
      lock: { redis: memRedis() },
    });
    expect(r.channels[0]!.productIds).toContain(sharedId);

    // 两行并存：event(success) + product(success)，同 target_id 不同 target_type 互不挤占。
    const { rows } = await pool!.query<{ target_type: string; status: string }>(
      `SELECT target_type, status FROM push_records
        WHERE target_id=$1 AND channel='telegram' AND push_date=$2
        ORDER BY target_type`,
      [sharedId, PUSH_DATE_1],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target_type)).toEqual(['event', 'product']);
    for (const row of rows) expect(row.status).toBe('success');
  });
});
