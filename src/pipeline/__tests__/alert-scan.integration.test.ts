/**
 * runAlertScan 端到端集成测试（任务 9.3，realtime-alerts）。
 * 需本地 Postgres。Redis 用注入的内存桩（lock.redis），不依赖真实 Redis。
 * 注入 mock collector / LLM(generateObject) / sender，实跑 collect→store→collapse→judge→阈值→告警。
 *
 * 覆盖场景（逐条对齐 9.3）：
 * - 高频链路评分后达阈值即告警（不等日报）。
 * - 评分前不以 NULL 误判（阈值判定在评分后；未达阈值/未评分不告警）。
 * - 日报已推同一事件仍可发 alert（不被 event 四元组吞）。
 * - 已告警过事件不重复告警（一生一次：从未 success 告警候选窗口）。
 * - 同日并发 UNIQUE 兜底（同四元组重复 dispatch 不双发）。
 * - 低于阈值不触发。
 * - 告警事件无摘要（headline_zh/summary_zh 均 NULL）时 headline 回退不报错。
 *
 * 缺 DATABASE_URL 时整套件 skip。每个用例用唯一 source/event 前缀隔离 + 全表清理本套件行。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { CollectedItem } from '../../collectors/types.js';
import type { MessageSender } from '../../push/dispatcher.js';
import type { RedisLike } from '../../push/lock.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runAlertScan, selectAlertCandidates } = await import('../alert-scan.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'alert-scan-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

// 固定参考时刻 → push_date 落在远未来专属日，隔离本套件 push_records（不撞真实运行日）。
const NOW = new Date('2098-03-04T04:00:00Z'); // 上海 2098-03-04 12:00
const ALERT_PUSH_DATE = '2098-03-04';

/** 内存 Redis 桩：SET NX PX + 「核对令牌再删」eval，供告警单例锁注入（不依赖真实 Redis）。 */
function memoryRedis(): RedisLike {
  const store = new Map<string, string>();
  return {
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

/** 成功发送器：记调用次数 + 文本（断言 headline 回退渲染不报错）。 */
function okSender(): MessageSender & { calls: number; texts: string[] } {
  const s = {
    calls: 0,
    texts: [] as string[],
    async send(text: string) {
      s.calls += 1;
      s.texts.push(text);
    },
  };
  return s;
}

/** 注入 collector：rss 返回给定条目，其余实时源空（arxiv/PH 本链路根本不采）。 */
function collectorsReturning(items: CollectedItem[]) {
  return {
    rss: async () => items,
    hackerNews: async () => [],
    github: async () => [],
  };
}

/** judge generateObject mock：所有事件给定 importance 分（控制是否达阈值）。 */
function judgeMock(importance: number) {
  return async () => ({
    object: {
      is_ai_related: true,
      type: 'news',
      category: 'AI',
      importance,
      novelty: 80,
      developer_relevance: 80,
      hype_risk: 10,
      should_push: true,
      reason: 'ok',
    },
  });
}

let seq = 0;
function rssItem(title: string, url: string | null): CollectedItem {
  seq += 1;
  return {
    source: 'rss',
    sourceItemId: `${SOURCE}-${Date.now()}-${seq}`,
    url,
    title,
    content: null,
    publishedAt: null,
    rawType: 'news',
  };
}

async function cleanup() {
  if (!pool) return;
  // 全表 TRUNCATE 隔离（同 run-daily-workflow.integration.test.ts）：runAlertScan 的候选查询是
  // **全局表读**（扫所有 importance>=阈值且从未 success 告警的事件），外部残留的高分事件会混入
  // alertCandidateCount / alertRecords 断言。TRUNCATE 确保全局读只看到本用例 seed 的数据。
  // ⚠️ 勿与真实 workflow / 其他写库套件**跨进程并发**跑；vitest 默认按文件分 worker、文件内顺序执行。
  await pool.query(
    `TRUNCATE TABLE push_records, ai_news_events, raw_items RESTART IDENTITY`,
  );
}

async function alertRecords() {
  const { rows } = await pool!.query<{
    target_id: string;
    channel: string;
    status: string;
  }>(
    `SELECT target_id, channel, status FROM push_records
      WHERE target_type = 'alert' AND push_date = $1 ORDER BY target_id, channel`,
    [ALERT_PUSH_DATE],
  );
  return rows;
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  if (pool) await pool.end();
});

const opts = (over: Record<string, unknown> = {}) => ({
  now: NOW,
  dbh: db!,
  channels: ['telegram'] as const,
  lock: { redis: memoryRedis(), ttlMs: 60_000 },
  log: () => {},
  // 测试用 NOW 是 2098 年，事件 first_seen_at 是当前时间（~2026），禁用时间窗口防测试被挡。
  windowDays: 0,
  // 测试每用例 TRUNCATE 全表后只有本用例 seed 的数据，上限不影响断言；给足空间即可。
  maxPerScan: 100,
  ...over,
});

describe.skipIf(!databaseUrl)('runAlertScan 实时重大发布告警', () => {
  it('评分后达阈值即告警（不等日报）；告警写 target_type=alert 四元组', async () => {
    const sender = okSender();
    const result = await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([rssItem('Big launch', 'https://x.com/big')]) },
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: sender },
        threshold: 85,
      }),
    );

    expect(result.collectedCount).toBe(1);
    expect(result.judged).toBeGreaterThanOrEqual(1);
    expect(result.alertCandidateCount).toBe(1);
    expect(sender.calls).toBe(1); // 评分后达阈值 → 即时告警（不等日报）。

    const rows = await alertRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('telegram');
    expect(rows[0]!.status).toBe('success');
  });

  it('Model B：channel-agnostic 选一次，同一告警事件发放给所有已配置通道（telegram + feishu）', async () => {
    const tg = okSender();
    const fs = okSender();
    const result = await runAlertScan(
      opts({
        channels: ['telegram', 'feishu'] as const,
        collect: { collectors: collectorsReturning([rssItem('Major release', 'https://x.com/major')]) },
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: tg, feishu: fs },
        threshold: 85,
      }),
    );

    // 候选 channel-agnostic 选一次（按事件计 1 条），同份发放给两个通道：两通道各发一次。
    expect(result.alertCandidateCount).toBe(1);
    expect(tg.calls).toBe(1);
    expect(fs.calls).toBe(1);
    // 同一事件在两通道各一条 alert success 记录（per-channel 同日幂等四元组）。
    const rows = await alertRecords();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(['feishu', 'telegram']);
    expect(rows.every((r) => r.status === 'success')).toBe(true);
  });

  it('低于阈值不触发；评分前不以 NULL 误判（未达阈值的已评分事件不告警）', async () => {
    const sender = okSender();
    const result = await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([rssItem('Minor update', 'https://x.com/minor')]) },
        judge: { judge: { generateObjectFn: judgeMock(80), logError: () => {} }, logError: () => {} },
        senders: { telegram: sender },
        threshold: 85,
      }),
    );

    expect(result.judged).toBeGreaterThanOrEqual(1); // 已评分（80 分）。
    expect(result.alertCandidateCount).toBe(0); // 80 < 85 → 不达阈值。
    expect(sender.calls).toBe(0); // 不告警。
    expect(await alertRecords()).toHaveLength(0);
  });

  it('日报已推同一事件仍可发 alert（不被 event 四元组吞）', async () => {
    // 造事件并评分达阈值，但**不**在本次 scan 里告警（用 collapse + 手写分隔离出「日报已推、
    // 尚未告警」的状态）：seed 一条 raw_item → 塌缩 → 手写 importance_score=90。
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `https://x.com/dual/${ts}`;
    const rir = await pool!.query<{ id: string }>(
      `INSERT INTO raw_items (source, source_item_id, url, title) VALUES ('rss', $1, $2, $3) RETURNING id`,
      [`${SOURCE}-${ts}`, url, 'Dual push event'],
    );
    const rawId = BigInt(rir.rows[0]!.id);
    const { collapseRawItem } = await import('../../dedup/collapse.js');
    const out = await collapseRawItem(
      { id: rawId, url, title: 'Dual push event', publishedAt: null, fetchedAt: new Date() },
      db!,
    );
    const evRow = await pool!.query<{ event_id: string }>(
      `SELECT event_id FROM ai_news_events WHERE dedup_key = $1`,
      [out.dedupKey],
    );
    const eventId = evRow.rows[0]!.event_id;
    await pool!.query(
      `UPDATE ai_news_events SET importance_score = '90', should_push = true WHERE event_id = $1`,
      [eventId],
    );

    // 模拟「日报（target_type='event'）当日已 success 推过该事件」（尚无 alert 记录）。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status)
       VALUES ('event', $1, 'telegram', $2, 'success')`,
      [eventId, ALERT_PUSH_DATE],
    );

    // 关键断言：alert 候选不被 event 记录吞——event(success) 在不同 target_type 命名空间，
    // 候选「从未以任一通道 **alert** success」仍满足，该事件仍是 alert 候选（channel-agnostic）。
    const candidates = await selectAlertCandidates(85, db!);
    const found = candidates.find((c) => c.eventId === eventId);
    expect(found).toBeDefined();

    // 实跑 scan（无新采集条目）→ 对该达阈值事件发 alert，与既有 event 行互不挤占。
    const sender = okSender();
    await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([]) },
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: sender },
        threshold: 85,
      }),
    );
    expect(sender.calls).toBe(1); // 日报已推不阻止 alert。

    const { rows } = await pool!.query<{ target_type: string; status: string }>(
      `SELECT target_type, status FROM push_records WHERE target_id = $1 AND push_date = $2 ORDER BY target_type`,
      [eventId, ALERT_PUSH_DATE],
    );
    // alert(success) + event(success) 两行：四元组按 target_type 分裂、不互相吞。
    expect(rows.map((r) => r.target_type)).toEqual(['alert', 'event']);
    for (const r of rows) expect(r.status).toBe('success');
  });

  it('已告警过事件不重复告警（一生一次：从未 success 告警候选窗口）', async () => {
    const items = collectorsReturning([rssItem('Repeat', 'https://x.com/repeat')]);
    // 第一次：达阈值 → 告警 success。
    const s1 = okSender();
    await runAlertScan(
      opts({
        collect: { collectors: items },
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: s1 },
        threshold: 85,
      }),
    );
    expect(s1.calls).toBe(1);

    // 第二次同 push_date 再扫（事件已评分、已 success 告警）：候选窗口「从未 success 告警」排除它。
    const s2 = okSender();
    const r2 = await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([]) }, // 无新条目。
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: s2 },
        threshold: 85,
      }),
    );
    expect(r2.alertCandidateCount).toBe(0); // 已 success 告警 → 不再候选。
    expect(s2.calls).toBe(0); // 不重复告警。
    expect(await alertRecords()).toHaveLength(1); // 仍只一行 alert(success)。
  });

  it('告警事件无摘要（headline/summary 均 NULL）时 headline 回退不报错', async () => {
    // 高频链路评分后**不**跑中文摘要 → headline_zh/summary_zh 恒 NULL。
    const sender = okSender();
    const result = await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([rssItem('No summary event', 'https://x.com/nosum')]) },
        judge: { judge: { generateObjectFn: judgeMock(95), logError: () => {} }, logError: () => {} },
        senders: { telegram: sender },
        threshold: 85,
      }),
    );
    expect(result.alertCandidateCount).toBe(1);
    expect(sender.calls).toBe(1); // headline 回退链（→ representative_title）渲染成功、不报错。
    // 渲染文本含代表标题（回退到标题），不空。
    expect(sender.texts[0]).toContain('No summary event');

    // 库内确认该事件 headline_zh/summary_zh 仍 NULL（高频链不摘要）。TRUNCATE 隔离 → 唯一行。
    const { rows } = await pool!.query<{ summary_zh: string | null; headline_zh: string | null }>(
      `SELECT summary_zh, headline_zh FROM ai_news_events`,
    );
    expect(rows[0]!.summary_zh).toBeNull();
    expect(rows[0]!.headline_zh).toBeNull();
  });

  it('同日并发 UNIQUE 兜底：手插 alert success 行后再扫不再候选/重发', async () => {
    // 造事件评分达阈值，但先手插一条 alert(success) 模拟「另一并发实例已发」。
    const s0 = okSender();
    await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([rssItem('Concurrent alert', 'https://x.com/conc')]) },
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: s0 },
        threshold: 85,
      }),
    );
    // 第一次已 success 告警一行；候选窗口（从未 success）下，UNIQUE(alert,event,channel,push_date)
    // 兜底同日并发：再扫不再候选、不重发。
    const s1 = okSender();
    const r1 = await runAlertScan(
      opts({
        collect: { collectors: collectorsReturning([]) },
        judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
        senders: { telegram: s1 },
        threshold: 85,
      }),
    );
    expect(r1.alertCandidateCount).toBe(0);
    expect(s1.calls).toBe(0);
    expect(await alertRecords()).toHaveLength(1);
  });
});
