/**
 * backfillPublishedAt 集成测试（published-at-inference 1.7）——需本地 Postgres。
 * Redis 用注入的内存桩；LLM(generateObject) 用注入 mock。缺 DATABASE_URL 时整套件 skip。
 *
 * 验证「真实 SQL 语义」不变量（mock 桩无法覆盖、必须真库）：
 * - 推断成功 → CAS 回填到 ai_news_events.published_at（读回一致）。
 * - **不覆盖已有 published_at**：published_at 非 NULL 的事件不进回填域、值不变。
 * - **CAS 防覆盖**：并发两次回填同一事件经 Redis 锁仅一次调 LLM；即便绕过锁两次推断，
 *   CAS `WHERE published_at IS NULL` 也保证仅一次落值（后写空操作）。
 * - **超窗剪枝**：first_seen_at 早于窗口下界的 NULL 老事件不纳入回填（即便达作用域条件）。
 * - **单次上限**：超出 maxPerRun 的候选本轮不回填、下轮补填。
 * - 作用域：daily（should_push=true）与 alert（importance>=threshold）各自正确选择。
 *
 * 每个用例用唯一 source/event 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema.js';
import type { RedisLike } from '../../../push/lock.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { backfillPublishedAt, publishedAtInferLockKey } = await import(
  '../backfill.js'
);

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'pub-at-backfill-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

// 固定参考时刻：上海 2098-03-04 12:00，窗口下界 startOfDay(now, windowDays-1) 落远未来专属日。
const NOW = new Date('2098-03-04T04:00:00Z');

/** 内存 Redis 桩（SET NX PX + 核对令牌再删 eval），供回填锁注入（同 alert-scan 集成测）。 */
function memoryRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set(key, value) {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval(_s, _n, key, token) {
      if (store.get(String(key)) === String(token)) {
        store.delete(String(key));
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
}

let seq = 0;
/**
 * Seed 一个事件 + 其代表 raw_item。直接 SQL 插入，绕过塌缩以精确控制 published_at / first_seen_at /
 * should_push / importance_score。返回 event_id。
 */
async function seedEvent(args: {
  publishedAt: Date | null;
  firstSeenAt: Date;
  shouldPush: boolean;
  importanceScore: number | null;
  title?: string;
}): Promise<string> {
  seq += 1;
  const sid = `${SOURCE}-${Date.now()}-${seq}`;
  const { rows: rawRows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, canonical_url, title, content)
     VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [
      SOURCE,
      sid,
      `https://example.com/${sid}`,
      args.title ?? 'Historic AI article',
      'body',
    ],
  );
  const rawId = BigInt(rawRows[0]!.id);
  const { rows: evtRows } = await pool!.query<{ event_id: string }>(
    `INSERT INTO ai_news_events
       (dedup_key, representative_raw_item_id, representative_title,
        first_seen_at, published_at, should_push, importance_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING event_id`,
    [
      `dk-${sid}`,
      rawId,
      args.title ?? 'Historic AI article',
      args.firstSeenAt,
      args.publishedAt,
      args.shouldPush,
      args.importanceScore,
    ],
  );
  return evtRows[0]!.event_id;
}

async function fetchPublishedAt(eventId: string): Promise<Date | null> {
  const { rows } = await pool!.query<{ published_at: Date | null }>(
    `SELECT published_at FROM ai_news_events WHERE event_id = $1`,
    [eventId],
  );
  return rows[0]?.published_at ?? null;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM ai_news_events WHERE representative_raw_item_id IN
       (SELECT id FROM raw_items WHERE source = $1)`,
    [SOURCE],
  );
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

/** mock generateObject 返回给定 publishedAt（ISO 串或 null）。 */
function inferMock(iso: string | null) {
  return vi.fn().mockResolvedValue({ object: { publishedAt: iso } });
}

// 窗口内的 first_seen_at（NOW 当天）；窗口下界 = startOfDay(NOW, windowDays-1)。
const IN_WINDOW_FIRST_SEEN = new Date('2098-03-04T03:00:00Z');
// 窗口外的 first_seen_at（远早于下界，windowDays=3 时下界约 2098-03-01 16:00Z）。
const OUT_OF_WINDOW_FIRST_SEEN = new Date('2098-01-01T00:00:00Z');
// 推断出的合法发布时间（范围内、<= NOW）。
const INFERRED_ISO = '2022-11-30T00:00:00Z';

describe.skipIf(!databaseUrl)('backfillPublishedAt（真实 DB CAS / 锁 / 剪枝）', () => {
  it('daily 作用域：should_push=true 且 published_at NULL → CAS 回填', async () => {
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: true,
      importanceScore: 90,
    });
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: db!,
      infer: { generateObjectFn: inferMock(INFERRED_ISO), logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(result.backfilled).toBeGreaterThanOrEqual(1);
    const after = await fetchPublishedAt(eventId);
    expect(after?.toISOString()).toBe('2022-11-30T00:00:00.000Z');
  });

  it('不覆盖已有 published_at：非 NULL 事件不进回填域、值不变', async () => {
    const existing = new Date('2020-01-01T00:00:00Z');
    const eventId = await seedEvent({
      publishedAt: existing,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: true,
      importanceScore: 90,
    });
    const generateObjectFn = inferMock(INFERRED_ISO);
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: db!,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    // 该事件 published_at 非 NULL → WHERE published_at IS NULL 不选中 → 不调 LLM、值不变。
    const after = await fetchPublishedAt(eventId);
    expect(after?.toISOString()).toBe(existing.toISOString());
  });

  it('超窗剪枝：first_seen_at 早于窗口下界的 NULL 事件不纳入回填', async () => {
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: OUT_OF_WINDOW_FIRST_SEEN,
      shouldPush: true,
      importanceScore: 90,
    });
    const generateObjectFn = inferMock(INFERRED_ISO);
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: db!,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    // 超窗 → 不进候选 → 不调 LLM、保持 NULL。
    expect(generateObjectFn).not.toHaveBeenCalled();
    const after = await fetchPublishedAt(eventId);
    expect(after).toBeNull();
  });

  it('windowDays=0 旁路（告警不限窗口）：first_seen 较早的 NULL 事件仍被回填', async () => {
    await cleanup();
    // 真实 new Date() 作 now（CAS 的 <= now() 走 DB 真实时钟）；first_seen = now - 5 天（>1 天，
    // windowDays>0 时本会被剪枝）。证明 windowDays=0 旁路不设 first_seen 下界、老首见事件仍进回填域。
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const twoDaysAgoIso = new Date(
      now.getTime() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: fiveDaysAgo,
      shouldPush: false, // alert 域不看 should_push。
      importanceScore: 90,
    });
    const result = await backfillPublishedAt({
      scope: { kind: 'alert', threshold: 85 },
      windowDays: 0,
      now,
      dbh: db!,
      infer: { generateObjectFn: inferMock(twoDaysAgoIso), logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(result.backfilled).toBeGreaterThanOrEqual(1);
    expect(await fetchPublishedAt(eventId)).not.toBeNull();
    await cleanup();
  });

  it('对照 windowDays=3：同样 first_seen 较早（5 天前）的 NULL 事件被剪枝（不回填）', async () => {
    await cleanup();
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: fiveDaysAgo,
      shouldPush: false,
      importanceScore: 90,
    });
    const generateObjectFn = inferMock(
      new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const result = await backfillPublishedAt({
      scope: { kind: 'alert', threshold: 85 },
      windowDays: 3,
      now,
      dbh: db!,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    // 超窗 → 不进候选 → 不调 LLM、保持 NULL。
    expect(result.attempted).toBe(0);
    expect(generateObjectFn).not.toHaveBeenCalled();
    expect(await fetchPublishedAt(eventId)).toBeNull();
    await cleanup();
  });

  it('单次上限：超出 maxPerRun 的候选本轮不回填（剩余下轮补）', async () => {
    await cleanup(); // 本用例独占计数，先清本套件残留。
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await seedEvent({
          publishedAt: null,
          firstSeenAt: new Date(IN_WINDOW_FIRST_SEEN.getTime() + i * 1000),
          shouldPush: true,
          importanceScore: 90,
        }),
      );
    }
    const generateObjectFn = inferMock(INFERRED_ISO);
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      maxPerRun: 2, // 3 条候选，上限 2 → 本轮只回填 2。
      dbh: db!,
      infer: { generateObjectFn, logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect(result.backfilled).toBe(2);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    // 第三条仍 NULL（下轮补）。
    const stillNull = (
      await Promise.all(ids.map((id) => fetchPublishedAt(id)))
    ).filter((d) => d === null);
    expect(stillNull.length).toBe(1);
    await cleanup();
  });

  it('并发两次回填同一事件经共享 Redis 锁仅一次调 LLM + CAS 仅一次落值', async () => {
    await cleanup();
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: true,
      importanceScore: 90,
    });
    const sharedRedis = memoryRedis();
    // 两个 generateObject mock 分属「日报链」「告警链」，共享同一 Redis（per-event 锁）。
    const dailyFn = inferMock(INFERRED_ISO);
    const alertFn = inferMock('2021-01-01T00:00:00Z'); // 不同值，放大「若两次都落值」的 bug。
    const [r1, r2] = await Promise.all([
      backfillPublishedAt({
        scope: { kind: 'daily' },
        windowDays: 3,
        now: NOW,
        dbh: db!,
        infer: { generateObjectFn: dailyFn, logError: () => {} },
        lock: { redis: sharedRedis },
        logError: () => {},
      }),
      backfillPublishedAt({
        scope: { kind: 'alert', threshold: 85 },
        windowDays: 3,
        now: NOW,
        dbh: db!,
        infer: { generateObjectFn: alertFn, logError: () => {} },
        lock: { redis: sharedRedis },
        logError: () => {},
      }),
    ]);
    // 仅一条链路抢到锁调 LLM；另一条 skippedLocked（per-event 锁防重复调 LLM）。
    const totalLlmCalls = dailyFn.mock.calls.length + alertFn.mock.calls.length;
    expect(totalLlmCalls).toBe(1);
    const totalBackfilled = r1.backfilled + r2.backfilled;
    const totalSkippedLocked = r1.skippedLocked + r2.skippedLocked;
    expect(totalBackfilled).toBe(1); // CAS 仅一次落值。
    expect(totalSkippedLocked).toBe(1); // 另一链路未抢到锁。
    // 落值为抢到锁那条链路的推断值（任一确定值都满足时效闸语义；只校验非 NULL 且单值）。
    const after = await fetchPublishedAt(eventId);
    expect(after).not.toBeNull();
    await cleanup();
  });

  it('alert 作用域：importance>=threshold 选中、<threshold 不选', async () => {
    await cleanup();
    const high = await seedEvent({
      publishedAt: null,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: false, // alert 域不看 should_push。
      importanceScore: 90,
    });
    const low = await seedEvent({
      publishedAt: null,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: false,
      importanceScore: 50, // < threshold 85。
    });
    await backfillPublishedAt({
      scope: { kind: 'alert', threshold: 85 },
      windowDays: 3,
      now: NOW,
      dbh: db!,
      infer: { generateObjectFn: inferMock(INFERRED_ISO), logError: () => {} },
      lock: { redis: memoryRedis() },
      logError: () => {},
    });
    expect((await fetchPublishedAt(high))?.toISOString()).toBe(
      '2022-11-30T00:00:00.000Z',
    );
    expect(await fetchPublishedAt(low)).toBeNull();
    await cleanup();
  });

  it('回填与评分锁隔离（任务 6.5）：回填不读写 judge_claimed_at、不致漏评分', async () => {
    // 证明 design D2「绝不复用 judge_claimed_at 列」：评分链已对该事件 claim（写 judge_claimed_at
    // 非 NULL + importance_score 已写）期间，回填链对同一事件走独立 Redis 锁 published-at-infer:{id}
    // 回填 published_at。断言：回填后 judge_claimed_at **原值不变**（回填不触该列）、published_at 已回填。
    await cleanup();
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: true,
      importanceScore: 90, // 评分链已评分（importance 非 NULL）。
    });
    // 模拟评分链已 claim：写 judge_claimed_at 为一个确定时刻。
    const claimedAt = new Date('2098-03-04T03:30:00Z');
    await pool!.query(
      `UPDATE ai_news_events SET judge_claimed_at = $1 WHERE event_id = $2`,
      [claimedAt, eventId],
    );

    const redis = memoryRedis();
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: db!,
      infer: { generateObjectFn: inferMock(INFERRED_ISO), logError: () => {} },
      lock: { redis },
      logError: () => {},
    });

    // judge_claimed_at 原值不变（回填只 set published_at；用独立 Redis 锁、不碰 DB claim 列）。
    const { rows } = await pool!.query<{ judge_claimed_at: Date | null; published_at: Date | null }>(
      `SELECT judge_claimed_at, published_at FROM ai_news_events WHERE event_id = $1`,
      [eventId],
    );
    expect(rows[0]!.judge_claimed_at?.toISOString()).toBe(claimedAt.toISOString());
    expect(rows[0]!.published_at?.toISOString()).toBe('2022-11-30T00:00:00.000Z');
    // 回填用的是 published-at-infer:{id} 锁，与评分链 judge_claimed_at 列正交：
    // 回填期间不曾以 alert:{id} 或任何 DB claim 列与评分链争用（锁键独立）。
    expect(redis.store.has(publishedAtInferLockKey(eventId))).toBe(false); // finally 已释放。
    await cleanup();
  });

  it('回填锁键为 published-at-infer:{event_id}（与告警锁区分，跑后释放不死锁）', async () => {
    await cleanup();
    const eventId = await seedEvent({
      publishedAt: null,
      firstSeenAt: IN_WINDOW_FIRST_SEEN,
      shouldPush: true,
      importanceScore: 90,
    });
    const redis = memoryRedis();
    await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 3,
      now: NOW,
      dbh: db!,
      infer: { generateObjectFn: inferMock(INFERRED_ISO), logError: () => {} },
      lock: { redis },
      logError: () => {},
    });
    // finally 释放后回填锁键不残留（不死锁）；且键名是 published-at-infer:，非 alert:。
    expect(redis.store.has(publishedAtInferLockKey(eventId))).toBe(false);
    expect(redis.store.has(`alert:${eventId}`)).toBe(false);
    await cleanup();
  });
});
