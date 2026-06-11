/**
 * 周报端到端集成测试（任务 10.2 / 10.3，weekly-report「周报推送幂等按周粒度」）。
 * 需本地 Postgres + Redis（compose 起的）。mock 注入 sender 断言状态机，不触真实 Telegram/飞书。
 *
 * 覆盖场景：
 * - 程序规则选窗口内高价值事件/产品 → 复用已落库摘要拼周报 → 推送（10.1/10.2）；
 * - 同一周周报不重复推：success 后再跑同 iso_week → UNIQUE(weekly,iso_week,channel,push_date) 跳过（10.3）；
 * - 周报与日报 target_type 不同互不挤占：同期 event 与 weekly 各自独立幂等（10.3）；
 * - merge_conflict 产品排除出周报正文（10.1）；
 * - 跨 ISO 周边界抖动（同一触发周内不同 weekday 触发）不改变 target_id/push_date（10.2）；
 * - 独立单例锁 weekly:{channel}:{iso_week}：并发两实例仅一份送达（10.2）。
 *
 * 缺 DATABASE_URL / REDIS_URL 时整套件自动跳过。用唯一前缀隔离造的行，afterEach/afterAll 清理。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import * as schema from '../../db/schema.js';
import type { MessageSender } from '../../push/dispatcher.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph';

const {
  runWeeklyReport,
  weeklyAnchor,
  acquireWeeklyReportLock,
  weeklyLockKey,
} = await import('../weekly-report.js');

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const canRun = Boolean(databaseUrl && redisUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

// 固定触发时刻：2026-06-08 周一 09:07 SH（01:07 UTC）。触发 ISO 周 W24 → 汇总窗口 = 上周 W23
// [2026-06-01 SH 00:00, 2026-06-08 SH 00:00)。锚点 iso_week=2026-W23、push_date=2026-06-01。
const TRIGGER = new Date('2026-06-08T01:07:00Z');
const ANCHOR = weeklyAnchor(TRIGGER);
// 窗口内一个时刻（用于 first_seen_at / last_seen_at）：窗口下界 + 1 天。
const IN_WINDOW = new Date(ANCHOR.windowStart.getTime() + 24 * 3600 * 1000);
// 窗口外一个时刻（窗口上界 + 1 天，落在触发周本身——不应入汇总）。
const OUT_OF_WINDOW = new Date(ANCHOR.windowEnd.getTime() + 24 * 3600 * 1000);

const EVENT_PREFIX = 'weekly-itest-evt-';
const PRODUCT_NAME_PREFIX = '[WITEST]';

/** 注入用：短 TTL 锁（每用例独占 iso_week，不互相挡锁）。 */
const LOCK_OPTS = { ttlMs: 30_000 };

function okSender(): MessageSender & { calls: number; lastText: string | null } {
  const s = {
    calls: 0,
    lastText: null as string | null,
    async send(text: string) {
      s.calls += 1;
      s.lastText = text;
    },
  };
  return s;
}

function failSender(message = 'weekly boom'): MessageSender & { calls: number } {
  const s = {
    calls: 0,
    async send(): Promise<void> {
      s.calls += 1;
      throw new Error(message);
    },
  };
  return s;
}

/** 插一条窗口内高价值事件（should_push + importance 过闸 + 落库摘要）。返回 event_id。 */
async function insertWeeklyEvent(args: {
  id: string;
  title: string;
  summaryZh: string | null;
  headlineZh: string | null;
  firstSeenAt: Date;
  importance?: number;
  shouldPush?: boolean;
}): Promise<string> {
  const eventId = `${EVENT_PREFIX}${args.id}`;
  await pool!.query(
    `INSERT INTO ai_news_events
       (event_id, representative_title, summary_zh, headline_zh, first_seen_at,
        last_seen_at, published_at, importance_score, novelty_score,
        developer_relevance_score, hype_risk_score, should_push)
     VALUES ($1,$2,$3,$4,$5,$5,$5,$6,80,80,10,$7)`,
    [
      eventId,
      args.title,
      args.summaryZh,
      args.headlineZh,
      args.firstSeenAt.toISOString(),
      String(args.importance ?? 90),
      args.shouldPush ?? true,
    ],
  );
  return eventId;
}

/** 插一条产品（可选标 merge_conflict）。返回 product_id。 */
async function insertWeeklyProduct(args: {
  name: string;
  lastSeenAt: Date;
  mergeConflict?: boolean;
}): Promise<string> {
  const metadata = args.mergeConflict
    ? JSON.stringify({ merge_conflict: { conflict_with: ['other'] } })
    : null;
  const { rows } = await pool!.query<{ product_id: string }>(
    `INSERT INTO ai_products (name, last_seen_at, first_seen_at, metadata)
     VALUES ($1,$2,$2,$3) RETURNING product_id`,
    [args.name, args.lastSeenAt.toISOString(), metadata],
  );
  return rows[0]!.product_id;
}

async function fetchWeeklyRecords(channel = 'telegram') {
  const { rows } = await pool!.query<{
    target_id: string;
    push_date: string;
    status: string;
  }>(
    `SELECT target_id, to_char(push_date,'YYYY-MM-DD') AS push_date, status
       FROM push_records
      WHERE target_type='weekly' AND channel=$1 AND target_id=$2`,
    [channel, ANCHOR.isoWeek],
  );
  return rows;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM ai_news_events WHERE event_id LIKE $1`, [`${EVENT_PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE name LIKE $1`, [`${PRODUCT_NAME_PREFIX}%`]);
  await pool.query(`DELETE FROM push_records WHERE target_type='weekly' AND target_id=$1`, [
    ANCHOR.isoWeek,
  ]);
  // 事件日报记录（非挤占用例造的）也清。
  await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${EVENT_PREFIX}%`]);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool?.end();
  if (redisUrl) {
    const r = new Redis(redisUrl);
    const keys = await r.keys('weekly:*:2026-W23');
    if (keys.length) await r.del(...keys);
    r.disconnect();
  }
});

describe.skipIf(!canRun)('周报端到端：选名单 + 推送 + 按周幂等', () => {
  it('选窗口内高价值事件/产品 → 复用已落库摘要拼周报 → 推送（target_id=iso_week, push_date=汇总周周一）', async () => {
    await insertWeeklyEvent({
      id: 'a1',
      title: 'GPT-X 发布',
      summaryZh: '这是已落库的中文摘要',
      headlineZh: '一句话要点：模型发布',
      firstSeenAt: IN_WINDOW,
    });
    // 窗口外事件不应入选。
    await insertWeeklyEvent({
      id: 'out',
      title: '窗口外事件',
      summaryZh: 's',
      headlineZh: 'h',
      firstSeenAt: OUT_OF_WINDOW,
    });
    await insertWeeklyProduct({ name: `${PRODUCT_NAME_PREFIX} 新品A`, lastSeenAt: IN_WINDOW });

    const sender = okSender();
    const result = await runWeeklyReport({
      now: TRIGGER,
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: sender },
      lock: LOCK_OPTS,
    });

    expect(result.isoWeek).toBe('2026-W23');
    expect(result.pushDate).toBe('2026-06-01');
    expect(result.eventCount).toBe(1); // 窗口外事件被排除。
    expect(result.productCount).toBe(1);
    expect(sender.calls).toBe(1); // 一份周报一条消息原子送达。
    // 正文复用已落库摘要（不触 LLM）：消息含 headline 文本。
    expect(sender.lastText).toContain('一句话要点：模型发布');
    expect(result.channels[0]!.outcome).toBe('sent');
    expect(result.channels[0]!.targetIds).toEqual(['2026-W23']);

    // 幂等四元组：单行 target_type=weekly, target_id=iso_week, push_date=汇总周周一。
    const rows = await fetchWeeklyRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe('2026-W23');
    expect(rows[0]!.push_date).toBe('2026-06-01');
    expect(rows[0]!.status).toBe('success');
  });

  it('merge_conflict 产品排除出周报正文', async () => {
    await insertWeeklyProduct({ name: `${PRODUCT_NAME_PREFIX} 正常品`, lastSeenAt: IN_WINDOW });
    await insertWeeklyProduct({
      name: `${PRODUCT_NAME_PREFIX} 冲突品`,
      lastSeenAt: IN_WINDOW,
      mergeConflict: true,
    });

    const sender = okSender();
    const result = await runWeeklyReport({
      now: TRIGGER,
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: sender },
      lock: LOCK_OPTS,
    });
    expect(result.productCount).toBe(1); // 冲突品被排除，仅正常品。
    expect(sender.lastText).toContain('正常品');
    expect(sender.lastText).not.toContain('冲突品');
  });

  it('同一周周报不重复推：success 后再跑同 iso_week → UNIQUE 冲突跳过', async () => {
    await insertWeeklyEvent({
      id: 'rerun',
      title: '事件',
      summaryZh: 's',
      headlineZh: 'h',
      firstSeenAt: IN_WINDOW,
    });

    const s1 = okSender();
    const r1 = await runWeeklyReport({
      now: TRIGGER,
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: s1 },
      lock: LOCK_OPTS,
    });
    expect(r1.channels[0]!.outcome).toBe('sent');
    expect(s1.calls).toBe(1);

    // 再跑同一 iso_week（哪怕换一个落在同触发周的时刻）：待发集合空（已 success）→ skipped，不重发。
    const s2 = okSender();
    const r2 = await runWeeklyReport({
      now: new Date('2026-06-10T04:00:00Z'), // 周三 12:00 SH，同触发周 W24 → 同 iso_week W23
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: s2 },
      lock: LOCK_OPTS,
    });
    expect(r2.isoWeek).toBe('2026-W23'); // 同 iso_week（抖动不改变）。
    expect(r2.channels[0]!.outcome).toBe('skipped');
    expect(s2.calls).toBe(0); // 不重发。

    // push_records 仍只一行（四元组唯一）。
    const rows = await fetchWeeklyRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
  });

  it('周报与日报 target_type 不同互不挤占：同 event_id 各自独立', async () => {
    // 造一个 event 在「日报」通道已 success（target_type=event）。
    const eventId = await insertWeeklyEvent({
      id: 'coexist',
      title: '共存事件',
      summaryZh: 's',
      headlineZh: 'h',
      firstSeenAt: IN_WINDOW,
    });
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('event', $1, 'telegram', '2026-06-02', 'success', now())`,
      [eventId],
    );

    // 周报跑：weekly 命名空间独立，照常 success（不被 event success 吞）。
    const sender = okSender();
    const result = await runWeeklyReport({
      now: TRIGGER,
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: sender },
      lock: LOCK_OPTS,
    });
    expect(result.channels[0]!.outcome).toBe('sent');

    // event 行与 weekly 行各自独立存在、互不挤占。
    const { rows } = await pool!.query<{ target_type: string; status: string }>(
      `SELECT target_type, status FROM push_records
        WHERE channel='telegram' AND (target_id=$1 OR target_id=$2)
        ORDER BY target_type`,
      [eventId, ANCHOR.isoWeek],
    );
    // 'event'(success) + 'weekly'(success) 两条，互不影响。
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target_type)).toEqual(['event', 'weekly']);
    for (const r of rows) expect(r.status).toBe('success');
  });

  it('独立单例锁 weekly:{channel}:{iso_week}：并发两实例仅一份送达', async () => {
    await insertWeeklyEvent({
      id: 'lock',
      title: '事件',
      summaryZh: 's',
      headlineZh: 'h',
      firstSeenAt: IN_WINDOW,
    });

    // 预先占住该 (channel, iso_week) 的锁，模拟另一实例正在跑。
    const held = await acquireWeeklyReportLock('telegram', ANCHOR.isoWeek, LOCK_OPTS);
    expect(held).not.toBeNull();
    expect(held!.key).toBe(weeklyLockKey('telegram', ANCHOR.isoWeek));

    try {
      const sender = okSender();
      const result = await runWeeklyReport({
        now: TRIGGER,
        dbh: db!,
        channels: ['telegram'],
        senders: { telegram: sender },
        lock: LOCK_OPTS,
      });
      // 未抢到锁 → 本实例放弃该通道，不发送。
      expect(result.channels[0]!.outcome).toBe('locked');
      expect(sender.calls).toBe(0);
    } finally {
      await held!.release();
    }

    // 释放后可重新获取（验证 finally 释放路径）。
    const again = await acquireWeeklyReportLock('telegram', ANCHOR.isoWeek, LOCK_OPTS);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it('发送失败：整批 failed，可重试转 success（同一 iso_week 待发集合重新纳入）', async () => {
    await insertWeeklyEvent({
      id: 'retry',
      title: '事件',
      summaryZh: 's',
      headlineZh: 'h',
      firstSeenAt: IN_WINDOW,
    });

    const r1 = await runWeeklyReport({
      now: TRIGGER,
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: failSender('网络炸了') },
      lock: LOCK_OPTS,
    });
    expect(r1.channels[0]!.outcome).toBe('failed');
    let rows = await fetchWeeklyRecords();
    expect(rows[0]!.status).toBe('failed');

    // 重试同 iso_week：failed 仍属待发集合 → 重发转 success。
    const s2 = okSender();
    const r2 = await runWeeklyReport({
      now: TRIGGER,
      dbh: db!,
      channels: ['telegram'],
      senders: { telegram: s2 },
      lock: LOCK_OPTS,
    });
    expect(r2.channels[0]!.outcome).toBe('sent');
    expect(s2.calls).toBe(1);
    rows = await fetchWeeklyRecords();
    expect(rows[0]!.status).toBe('success');
  });
});
