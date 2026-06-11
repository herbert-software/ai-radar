/**
 * 推送 Dispatcher + 单例锁集成测试（任务 9.5，**pushIdempotency 不变量**）。
 * 需本地 Postgres + Redis（compose 起的）。mock 发送器断言状态机，不依赖真实 Telegram。
 *
 * 覆盖场景：
 * - 当天重跑：已 success 后待发集合为空 → 不重发。
 * - 发送失败：整批 failed + error_message，下次执行重新纳入待发集合重试。
 * - 僵尸 pending：上次插 pending 后崩溃未发 → 下次仍属待发集合被重发。
 * - 单例锁：并发两实例仅一份送达（另一被锁挡下）。
 * - 锁崩溃未释放：TTL 到期后同 push_date 可重新获取（不死锁）。
 * - UNIQUE(target_type,target_id,channel,push_date)：同四元组不重复插行（ON CONFLICT DO NOTHING）。
 *
 * 缺 DATABASE_URL / REDIS_URL 时本套件自动跳过。每个用例用唯一 event_id / push_date 隔离。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import * as schema from '../../db/schema.js';
import type { SelectedEvent } from '../../selection/top-n.js';
import type { MessageSender } from '../dispatcher.js';

// 间接 import config/env（启动期校验全部必填变量）。注入占位让无 Telegram 凭据也能跑；
// 真实 DATABASE_URL / REDIS_URL 仍由 .env / CI 注入（缺则整套件 skip）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';

const { dispatchDigest, computePendingSet } = await import('../dispatcher.js');
const { acquireDigestLock } = await import('../lock.js');

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const canRun = Boolean(databaseUrl && redisUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const CHANNEL = 'telegram';
const TARGET_TYPE = 'event';
// 用专属 push_date（远离真实运行日）+ event_id 前缀隔离本套件造的 push_records 行。
const TEST_PUSH_DATE = '2099-01-01';
const EVENT_PREFIX = 'dispatch-itest-';

/** 造一个不入库 event 表、仅作 dispatcher 输入的 SelectedEvent（dispatcher 只用 event_id/标题/摘要）。 */
function ev(suffix: string, title = 'T', summary: string | null = '摘要'): SelectedEvent {
  return {
    eventId: `${EVENT_PREFIX}${suffix}`,
    representativeTitle: title,
    summaryZh: summary,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
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

/** 失败发送器：抛错（dispatcher 据此整批 failed）。 */
function failSender(message = 'telegram boom'): MessageSender & { calls: number } {
  const s = {
    calls: 0,
    async send(): Promise<void> {
      s.calls += 1;
      throw new Error(message);
    },
  };
  return s;
}

async function fetchRecords(eventIds: string[]) {
  const { rows } = await pool!.query<{
    target_id: string;
    status: string;
    error_message: string | null;
    pushed_at: Date | null;
  }>(
    `SELECT target_id, status, error_message, pushed_at
       FROM push_records
      WHERE target_type = $1 AND channel = $2 AND push_date = $3
        AND target_id = ANY($4)
      ORDER BY target_id`,
    [TARGET_TYPE, CHANNEL, TEST_PUSH_DATE, eventIds],
  );
  return rows;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM push_records WHERE target_id LIKE $1`,
    [`${EVENT_PREFIX}%`],
  );
}

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  await pool?.end();
  if (redisUrl) {
    const r = new Redis(redisUrl);
    const keys = await r.keys('daily-digest:2099-*');
    if (keys.length) await r.del(...keys);
    r.disconnect();
  }
});

// 用固定时刻让 getPushDate 落在 TEST_PUSH_DATE（Asia/Shanghai 的 2099-01-01 白天）。
const NOW = new Date('2099-01-01T04:00:00Z'); // 上海 2099-01-01 12:00

describe.skipIf(!canRun)('推送状态机与待发集合（pushIdempotency）', () => {
  it('首次发送：无记录者插 pending 后整批 success + pushed_at', async () => {
    const events = [ev('a1'), ev('a2')];
    const sender = okSender();
    const result = await dispatchDigest(events, { now: NOW, sender }, db!);

    expect(result.outcome).toBe('sent');
    expect(result.pending).toBe(2);
    expect(sender.calls).toBe(1); // 单消息原子：只发一条。

    const rows = await fetchRecords(events.map((e) => e.eventId));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('success');
      expect(r.pushed_at).not.toBeNull();
    }
  });

  it('当天重跑：已 success 的事件待发集合为空 → 不重发', async () => {
    const events = [ev('a1'), ev('a2')]; // 同上一用例，已 success。
    const pending = await computePendingSet(events, TEST_PUSH_DATE, db!);
    expect(pending).toHaveLength(0);

    const sender = okSender();
    const result = await dispatchDigest(events, { now: NOW, sender }, db!);
    expect(result.outcome).toBe('skipped');
    expect(sender.calls).toBe(0);
  });

  it('发送失败：整批 failed + error_message，下次执行重试并可转 success', async () => {
    const events = [ev('b1'), ev('b2')];

    const sender1 = failSender('网络炸了');
    const r1 = await dispatchDigest(events, { now: NOW, sender: sender1 }, db!);
    expect(r1.outcome).toBe('failed');

    let rows = await fetchRecords(events.map((e) => e.eventId));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('failed');
      expect(r.error_message).toContain('网络炸了');
    }

    // failed 仍属待发集合（非今日 success）→ 重试。
    const pending = await computePendingSet(events, TEST_PUSH_DATE, db!);
    expect(pending.map((e) => e.eventId).sort()).toEqual(
      events.map((e) => e.eventId).sort(),
    );

    const sender2 = okSender();
    const r2 = await dispatchDigest(events, { now: NOW, sender: sender2 }, db!);
    expect(r2.outcome).toBe('sent');
    expect(sender2.calls).toBe(1);

    rows = await fetchRecords(events.map((e) => e.eventId));
    for (const r of rows) {
      expect(r.status).toBe('success');
      expect(r.error_message).toBeNull(); // 成功清空 error_message。
    }
  });

  it('僵尸 pending：手插 pending 后未发 → 仍属待发集合被重发转 success', async () => {
    const event = ev('c1');
    // 模拟「上次插 pending 后进程崩溃、未实际发送」。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [TARGET_TYPE, event.eventId, CHANNEL, TEST_PUSH_DATE],
    );

    const pending = await computePendingSet([event], TEST_PUSH_DATE, db!);
    expect(pending).toHaveLength(1); // pending 纳入待发集合。

    const sender = okSender();
    const result = await dispatchDigest([event], { now: NOW, sender }, db!);
    expect(result.outcome).toBe('sent');
    expect(sender.calls).toBe(1);

    const rows = await fetchRecords([event.eventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
  });

  it('截断：仅实际发出者置 success，被截断事件保持 pending（不永久漏推）', async () => {
    // 标题/要点均有渲染期上界，唯 canonical_url 无硬上界；用超长 URL 造整条事件级截断（极端兜底）。
    const longUrl = 'https://example.com/' + 'a'.repeat(1500);
    const events = Array.from({ length: 5 }, (_, i) => ({
      ...ev(`trunc-${i}`, 'T', null),
      canonicalUrl: longUrl,
    }));

    const sender = okSender();
    const result = await dispatchDigest(events, { now: NOW, sender }, db!);
    expect(result.outcome).toBe('sent');
    expect(sender.calls).toBe(1);
    // 实际发出的是子集，严格少于全部。
    expect(result.eventIds.length).toBeGreaterThan(0);
    expect(result.eventIds.length).toBeLessThan(events.length);

    const rows = await fetchRecords(events.map((e) => e.eventId));
    expect(rows).toHaveLength(events.length); // 全部已 INSERT pending。
    const sentSet = new Set(result.eventIds);
    for (const r of rows) {
      if (sentSet.has(r.target_id)) {
        expect(r.status).toBe('success');
        expect(r.pushed_at).not.toBeNull();
      } else {
        // 被截断未发出 → 保持 pending（下次运行重新纳入待发集合重发）。
        expect(r.status).toBe('pending');
        expect(r.pushed_at).toBeNull();
      }
    }

    // 被截断者仍属待发集合 → 下次会重发。
    const pending = await computePendingSet(events, TEST_PUSH_DATE, db!);
    const pendingIds = new Set(pending.map((e) => e.eventId));
    for (const e of events) {
      if (sentSet.has(e.eventId)) {
        expect(pendingIds.has(e.eventId)).toBe(false); // 已 success 不再待发。
      } else {
        expect(pendingIds.has(e.eventId)).toBe(true); // 被截断者仍待发。
      }
    }
  });

  it('ON CONFLICT DO NOTHING：同四元组重复 dispatch 不新增行（唯一约束行为）', async () => {
    const event = ev('d1');
    // 先 failed 一次（建一行）。
    await dispatchDigest([event], { now: NOW, sender: failSender() }, db!);
    // 再 dispatch（pending 已存在，ON CONFLICT DO NOTHING 不应新增行）。
    await dispatchDigest([event], { now: NOW, sender: okSender() }, db!);

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM push_records
        WHERE target_type=$1 AND channel=$2 AND push_date=$3 AND target_id=$4`,
      [TARGET_TYPE, CHANNEL, TEST_PUSH_DATE, event.eventId],
    );
    expect(Number(rows[0]!.n)).toBe(1); // 始终一行（四元组唯一）。
  });
});

describe.skipIf(!canRun)('channel 参数化幂等（同事件不同通道各自独立）', () => {
  /** 查某 (channel) 下某批 target 的记录（targetType 固定 event）。 */
  async function fetchByChannel(eventIds: string[], channel: string) {
    const { rows } = await pool!.query<{ target_id: string; status: string }>(
      `SELECT target_id, status FROM push_records
        WHERE target_type=$1 AND channel=$2 AND push_date=$3 AND target_id = ANY($4)
        ORDER BY target_id`,
      [TARGET_TYPE, channel, TEST_PUSH_DATE, eventIds],
    );
    return rows;
  }

  it('telegram 已 success 不抑制 feishu 待发：feishu 仍属待发集合', async () => {
    const events = [ev('chan-a1'), ev('chan-a2')];
    const ids = events.map((e) => e.eventId);

    // 先在 telegram 通道整批 success。
    const r1 = await dispatchDigest(
      events,
      { now: NOW, sender: okSender(), channel: 'telegram' },
      db!,
    );
    expect(r1.outcome).toBe('sent');

    // telegram 待发集合应为空（已 success）。
    const tgPending = await computePendingSet(
      events,
      TEST_PUSH_DATE,
      db!,
      'event',
      'telegram',
    );
    expect(tgPending).toHaveLength(0);

    // feishu 待发集合不被 telegram 的 success 抑制：仍含全部事件。
    const fsPending = await computePendingSet(
      events,
      TEST_PUSH_DATE,
      db!,
      'event',
      'feishu',
    );
    expect(fsPending.map((e) => e.eventId).sort()).toEqual([...ids].sort());

    // telegram 行存在且 success；feishu 行此刻尚不存在（待发但未 dispatch）。
    const tgRows = await fetchByChannel(ids, 'telegram');
    expect(tgRows).toHaveLength(2);
    for (const r of tgRows) expect(r.status).toBe('success');
    const fsRows = await fetchByChannel(ids, 'feishu');
    expect(fsRows).toHaveLength(0);

    // 清理本用例。
    await pool!.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [
      `${EVENT_PREFIX}chan-%`,
    ]);
  });

  it('同四元组按 channel 分裂为两个命名空间：telegram 与 feishu 各自一行（各自 dispatch）', async () => {
    // 飞书渲染已接入（组5）：用 mock sender 实跑 channel='feishu' dispatch，验四元组按 channel
    // 分裂、互不覆盖。telegram dispatch 建 telegram(success)，feishu dispatch 建 feishu(success)。
    const event = ev('chan-split', 'T', null);
    await dispatchDigest(
      [event],
      { now: NOW, sender: okSender(), channel: 'telegram' },
      db!,
    );
    const fsSender = okSender();
    const fsResult = await dispatchDigest(
      [event],
      { now: NOW, sender: fsSender, channel: 'feishu' },
      db!,
    );
    expect(fsResult.outcome).toBe('sent');
    expect(fsSender.calls).toBe(1);

    const { rows } = await pool!.query<{ channel: string; status: string }>(
      `SELECT channel, status FROM push_records
        WHERE target_type='event' AND target_id=$1 AND push_date=$2
        ORDER BY channel`,
      [event.eventId, TEST_PUSH_DATE],
    );
    // 两行：feishu(success) + telegram(success)，四元组按 channel 分裂、不互相覆盖。
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel)).toEqual(['feishu', 'telegram']);
    for (const r of rows) expect(r.status).toBe('success');

    await pool!.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [
      `${EVENT_PREFIX}chan-%`,
    ]);
  });

  it("飞书 channel 幂等（channel='feishu'）：当天重跑待发为空不重发", async () => {
    const events = [ev('fs-rerun-1', 'T', null), ev('fs-rerun-2', 'T', null)];
    // 首发飞书：整批 success。
    const s1 = okSender();
    const r1 = await dispatchDigest(
      events,
      { now: NOW, sender: s1, channel: 'feishu' },
      db!,
    );
    expect(r1.outcome).toBe('sent');
    expect(s1.calls).toBe(1);

    // 当天重跑同 channel='feishu'：已 success → 待发集合为空 → 不重发。
    const fsPending = await computePendingSet(events, TEST_PUSH_DATE, db!, 'event', 'feishu');
    expect(fsPending).toHaveLength(0);
    const s2 = okSender();
    const r2 = await dispatchDigest(
      events,
      { now: NOW, sender: s2, channel: 'feishu' },
      db!,
    );
    expect(r2.outcome).toBe('skipped');
    expect(s2.calls).toBe(0);

    await pool!.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [
      `${EVENT_PREFIX}fs-rerun-%`,
    ]);
  });
});

describe.skipIf(!canRun)('日报全局单例锁', () => {
  it('并发两实例仅一获锁：另一被挡下，只一份送达', async () => {
    const lockDate = '2099-01-02';
    const events = [ev('lock-x')];

    // 两实例同时尝试获锁。
    const [lockA, lockB] = await Promise.all([
      acquireDigestLock(lockDate, { ttlMs: 30_000 }),
      acquireDigestLock(lockDate, { ttlMs: 30_000 }),
    ]);

    // 恰好一个拿到，另一个为 null。
    const holders = [lockA, lockB].filter((l) => l !== null);
    expect(holders).toHaveLength(1);

    const holder = holders[0]!;
    const sender = okSender();
    try {
      // 只有持锁者执行推送。
      const now = new Date('2099-01-02T04:00:00Z');
      await dispatchDigest(events, { now, sender }, db!);
    } finally {
      await holder.release();
    }
    expect(sender.calls).toBe(1); // 仅一份送达。

    // 释放后可重新获取（验证 finally 释放路径）。
    const again = await acquireDigestLock(lockDate, { ttlMs: 30_000 });
    expect(again).not.toBeNull();
    await again!.release();

    // 清理本用例造的 push_records（push_date 不同于 TEST_PUSH_DATE，单独清）。
    await pool!.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [
      `${EVENT_PREFIX}lock-%`,
    ]);
  });

  it('锁崩溃未释放：TTL 到期后同 push_date 可重新获取（不死锁）', async () => {
    const lockDate = '2099-01-03';

    // 持锁者「崩溃」：拿锁后既不 release、关掉续租（renewIntervalMs=0），用很短 TTL 模拟崩溃后过期。
    const crashed = await acquireDigestLock(lockDate, {
      ttlMs: 300,
      renewIntervalMs: 0,
    });
    expect(crashed).not.toBeNull();
    // 故意不调用 crashed.release()——模拟崩溃。

    // 立刻再取应失败（锁仍在）。
    const immediate = await acquireDigestLock(lockDate, {
      ttlMs: 300,
      renewIntervalMs: 0,
    });
    expect(immediate).toBeNull();

    // 等 TTL 过期后应能重新获取（不死锁）。
    await new Promise((r) => setTimeout(r, 500));
    const recovered = await acquireDigestLock(lockDate, { ttlMs: 30_000 });
    expect(recovered).not.toBeNull();
    await recovered!.release();
    // crashed 的句柄此时残留 interval 已禁用、无需 release（其锁已过期）。
  });
});
