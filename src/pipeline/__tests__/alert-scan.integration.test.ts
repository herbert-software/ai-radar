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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
// 6.3：语义合并 / KB 入库模块，供 vi.spyOn 断言**告警链不调用**它们（保持硬去重快路径）。
const semanticMergeModule = await import('../../dedup/semantic-merge.js');
const kbModule = await import('../../kb/index.js');

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
// 默认 publishedAt = NOW（在窗口内、不超未来上界）：候选时效闸键于 published_at，且 windowDays=0
// 旁路仍排除 NULL/未来（须显式 isNotNull + lte(now)）。故 dispatch/幂等类用例的 rss 事件必须带
// 一个「过去/现在」的 published_at 才能过时效闸——否则被 NULL 排除（那是时效闸用例的关注点，
// 在独立 describe 块用 seedScoredEvent 覆盖）。
function rssItem(
  title: string,
  url: string | null,
  publishedAt: Date | null = NOW,
): CollectedItem {
  seq += 1;
  return {
    source: 'rss',
    sourceItemId: `${SOURCE}-${Date.now()}-${seq}`,
    url,
    title,
    content: null,
    publishedAt,
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

/**
 * 直接 seed 一个已评分（importance_score >= 阈值）事件，控制 published_at / first_seen_at
 * 以隔离「时效闸」变量（importance 固定达阈值 → 唯一变化的是 published_at 是否在窗口内）。
 * @returns 生成的 event_id（DB gen_random_uuid()::text）。
 */
async function seedScoredEvent(args: {
  title: string;
  importance?: number;
  publishedAt: Date | null;
  firstSeenAt?: Date;
}): Promise<string> {
  const { rows } = await pool!.query<{ event_id: string }>(
    `INSERT INTO ai_news_events
       (representative_title, importance_score, published_at, first_seen_at)
     VALUES ($1, $2, $3, $4)
     RETURNING event_id`,
    [
      args.title,
      String(args.importance ?? 90),
      args.publishedAt,
      args.firstSeenAt ?? new Date(),
    ],
  );
  return rows[0]!.event_id;
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

  it('6.3 告警链不触发语义合并 / KB 入库（保持硬去重快路径，仅日报链做语义层）', async () => {
    // spy 语义合并 / KB 入库编排入口：跑一次产生并处理事件的完整 alert-scan（含 collapse + dispatch），
    // 断言二者**零调用**——语义去重与 KB 入库仅日报链执行，告警链恒走硬去重快路径（spec / design D3）。
    const semanticSpy = vi.spyOn(semanticMergeModule, 'semanticMergeEvents');
    const kbSpy = vi.spyOn(kbModule, 'runKbIngestion');
    try {
      const sender = okSender();
      const result = await runAlertScan(
        opts({
          collect: { collectors: collectorsReturning([rssItem('Alert no semantic', 'https://x.com/ns')]) },
          judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
          senders: { telegram: sender },
          threshold: 85,
        }),
      );
      // 告警链照常完成（采集→塌缩→评分→阈值→告警），但全程不调语义合并 / KB。
      expect(result.alertCandidateCount).toBe(1);
      expect(sender.calls).toBe(1);
      expect(semanticSpy).not.toHaveBeenCalled();
      expect(kbSpy).not.toHaveBeenCalled();
    } finally {
      semanticSpy.mockRestore();
      kbSpy.mockRestore();
    }
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
    // published_at=NOW（在窗口内、不超未来上界）：候选时效闸键于 published_at，windowDays=0 旁路仍
    // 排除 NULL；本用例关注「日报已推不吞 alert」，须让事件过时效闸才进候选。
    const out = await collapseRawItem(
      { id: rawId, url, title: 'Dual push event', publishedAt: NOW, fetchedAt: new Date() },
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
    // 传 now=NOW + windowDays=0：published_at=NOW 须以同一参考时刻判时效闸（否则被未来上界误排）。
    const candidates = await selectAlertCandidates(85, db!, ['telegram'], NOW, 0, 100);
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

/**
 * 任务 3.4 / 3.5（realtime-alerts）：告警候选时效闸键于 published_at 的行为固化。
 *
 * 全部用 seedScoredEvent 直接 seed 已评分（importance>=阈值）事件 + 直接调 selectAlertCandidates
 * 断言候选与否——固定 importance 达阈值 → 隔离「时效闸」为唯一变化变量。NOW=2098-03-04（远未来），
 * published_at 围绕它构造「窗口内 / 过旧 / NULL / 未来」。
 */
describe.skipIf(!databaseUrl)('selectAlertCandidates 时效闸键于 published_at', () => {
  const WINDOW_DAYS = 3;
  // 上海今天 00:00（windowDays=1 即今天）对应 UTC，作为「窗口内 / 过旧」分界参照。
  const dayInWindow = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000); // 昨天，必在近 3 天窗口内。
  const dayTooOld = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 天前，必出窗。
  const dayFuture = new Date(NOW.getTime() + 24 * 60 * 60 * 1000); // 明天，未来。

  it('windowDays>0：published_at 在窗口内且达阈值 → 候选', async () => {
    const id = await seedScoredEvent({ title: 'In window', publishedAt: dayInWindow });
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100);
    expect(cands.map((c) => c.eventId)).toContain(id);
  });

  it('windowDays>0：达阈值但 published_at 过旧（first_seen=今天）→ 不告警', async () => {
    // 历史老文场景：published_at 30 天前，但 first_seen_at 为今天（新增源今日首次抓到）。
    await seedScoredEvent({
      title: 'Old article seen today',
      publishedAt: dayTooOld,
      firstSeenAt: new Date(),
    });
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100);
    expect(cands).toHaveLength(0); // 键于 published_at（旧）→ 出窗，不被 first_seen=今天误纳。
  });

  it('windowDays>0：published_at 为 NULL（AI 也判不出）→ 不候选', async () => {
    await seedScoredEvent({ title: 'No published date', publishedAt: null });
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100);
    expect(cands).toHaveLength(0); // gte 对 NULL 返回假 → NULL 即排除。
  });

  it('windowDays>0：published_at 为未来 → 不告警（上界 lte(published_at, now) 排除）', async () => {
    await seedScoredEvent({ title: 'Future dated', publishedAt: dayFuture });
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100);
    expect(cands).toHaveLength(0); // 未来值 >= 下界恒真，但被上界排除。
  });

  it('windowDays=0（不限窗口）：NULL 与未来 published_at 仍被排除，仅过去/现在入候选', async () => {
    const past = await seedScoredEvent({ title: 'w0 past', publishedAt: dayTooOld }); // 旁路免下界 → 入候选。
    await seedScoredEvent({ title: 'w0 null', publishedAt: null }); // isNotNull 排除。
    await seedScoredEvent({ title: 'w0 future', publishedAt: dayFuture }); // lte(now) 上界排除。
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, 0, 100);
    const ids = cands.map((c) => c.eventId);
    expect(ids).toContain(past); // windowDays=0 只免下界，过旧的过去事件入候选。
    expect(ids).toHaveLength(1); // NULL 与未来均被排除（旁路不免 NULL 排除与未来上界）。
    expect(cands[0]!.eventId).toBe(past);
  });

  it('上界含等于（边界）：published_at = now 入候选，now + 1ms 出候选', async () => {
    const atNow = await seedScoredEvent({ title: 'eq now', publishedAt: new Date(NOW.getTime()) });
    await seedScoredEvent({ title: 'just future', publishedAt: new Date(NOW.getTime() + 1) });
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100);
    const ids = cands.map((c) => c.eventId);
    expect(ids).toContain(atNow); // <= now 含等于。
    expect(ids).toHaveLength(1); // now+1ms 未来排除。
  });

  it('单次上限取序按 published_at DESC（取最新发布）', async () => {
    const older = await seedScoredEvent({ title: 'older', publishedAt: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000) });
    const newer = await seedScoredEvent({ title: 'newer', publishedAt: new Date(NOW.getTime() - 1 * 24 * 3600 * 1000) });
    // maxCandidates=1 → 取 published_at 最新者（newer），不是 first_seen 最新者。
    const cands = await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 1);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.eventId).toBe(newer);
    expect(cands[0]!.eventId).not.toBe(older);
  });

  // ── 3.5：告警幂等不依赖时效字段——改字段后语义零变化。
  it('幂等四元组与 distinct-channel-count 子查询不依赖时效字段（改 published_at 后语义零变化）', async () => {
    // 一事件 published_at 在窗口内、达阈值、未告警 → 候选。
    const id = await seedScoredEvent({ title: 'idem candidate', publishedAt: dayInWindow });
    expect((await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100)).map((c) => c.eventId)).toContain(id);

    // 写入一条 alert(telegram, success)：distinct-channel-count 子查询命中（与 published_at 无关）→ 移出候选。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status)
       VALUES ('alert', $1, 'telegram', $2, 'success')`,
      [id, ALERT_PUSH_DATE],
    );
    // 一生一次：已对所有已配置通道(telegram) success → 不再候选（候选窗口靠四元组/子查询、非时效字段）。
    expect((await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100)).map((c) => c.eventId)).not.toContain(id);

    // failed 不算 success：手插 failed 行不影响候选资格（仍以 published_at 在窗口为候选）。
    const id2 = await seedScoredEvent({ title: 'failed retry', publishedAt: dayInWindow });
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status)
       VALUES ('alert', $1, 'telegram', $2, 'failed')`,
      [id2, ALERT_PUSH_DATE],
    );
    // failed 不满足 distinct success 子查询 → 仍候选（failed 跨天可重试，不被时效字段改动影响）。
    expect((await selectAlertCandidates(85, db!, ['telegram'], NOW, WINDOW_DAYS, 100)).map((c) => c.eventId)).toContain(id2);

    // 多通道：telegram success 但 feishu 未 success → 对 [telegram,feishu] 配置仍候选（distinct count 1 < 2）。
    expect(
      (await selectAlertCandidates(85, db!, ['telegram', 'feishu'], NOW, WINDOW_DAYS, 100)).map((c) => c.eventId),
    ).toContain(id);
  });
});

/**
 * 任务 4.4（fix-push-recency-by-published-at）：告警链发布时间回填阶段编排集成测试。
 *
 * runAlertScan 在 selectAlertCandidates 之前对「评分后达阈值且 published_at IS NULL」的事件调
 * published-at-inference 回填（mock 注入 generateObjectFn 控制推断结果）。断言：
 * - NULL published_at 达阈值事件经回填（推断窗口内日期）后入候选并被告警。
 * - AI 判不出（推断 null）→ 保持 NULL → 被时效闸排除（不告警）。
 * - 回填失败（推断抛错）不阻塞后续阶段（其余正常告警照常完成）。
 * - 回填只作用于「评分后达阈值」的 NULL 事件（在 selectAlertCandidates 之前）。
 *
 * **NOW 用真实 new Date()（不用上面套件的 2098 远未来锚点）**：回填 CAS 的 `WHERE 推断日期 <= now()`
 * 用 **DB 真实时钟**（双层防御的 SQL 层未来兜底，不可注入）。若用 2098 锚点，推断日期须落在 2098 窗口内
 * 却又须 <= DB 真实 now(≈当前)，二者矛盾 → CAS 恒不命中、回填永远失败。故本块用真实 now：窗口下界、
 * 候选时效闸、schema 范围上界、CAS now() 全部对齐真实时钟。afterEach TRUNCATE 隔离，不查 push_date，
 * 故落在真实今日的 alert 记录不影响断言。WINDOW_DAYS=3 + seedNullDateScoredEvent 直接 seed 已评分
 * （达阈值）+ published_at NULL + first_seen 近 now 的事件（带代表 raw_item，回填 innerJoin rawItems 需之），
 * 不注入采集条目（empty collectors）。回填锁注入内存 Redis（不依赖真实 Redis）。
 */
describe.skipIf(!databaseUrl)('runAlertScan 发布时间回填阶段（4.4）', () => {
  const WINDOW_DAYS = 3;
  // 真实 now：使窗口/schema 范围/CAS now() 全部对齐 DB 真实时钟（见块头）。
  const REAL_NOW = new Date();
  // 推断目标日期：昨天（落在 windowDays=3 窗口内，且 <= DB 真实 now()）。
  const IN_WINDOW_ISO = new Date(REAL_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

  /**
   * Seed 一个已评分（达阈值）+ published_at NULL + first_seen_at 近 now 的事件，并建代表 raw_item
   * 关联 representative_raw_item_id（回填查询 innerJoin rawItems 经此回指线索，无之则不进回填域）。
   * @returns event_id。
   */
  async function seedNullDateScoredEvent(args: {
    title: string;
    importance?: number;
  }): Promise<string> {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // collapsed=true：使 runAlertScan 的 collapseUncollapsedRawItems 不再把该 raw_item 重塌缩成
    // 新事件（否则每个 seed 会多出一个被重新评分的 NULL-published 事件污染候选断言）。
    // representative_raw_item_id 仍可经 id 回指此行（回填 innerJoin rawItems 不看 collapsed 标记）。
    const rir = await pool!.query<{ id: string }>(
      `INSERT INTO raw_items (source, source_item_id, url, title, collapsed) VALUES ('rss', $1, $2, $3, true) RETURNING id`,
      [`${SOURCE}-${ts}`, `https://x.com/bf/${ts}`, args.title],
    );
    const rawId = rir.rows[0]!.id;
    const { rows } = await pool!.query<{ event_id: string }>(
      `INSERT INTO ai_news_events
         (representative_title, representative_raw_item_id, importance_score, published_at, first_seen_at)
       VALUES ($1, $2, $3, NULL, $4)
       RETURNING event_id`,
      // first_seen_at = REAL_NOW（落在 windowDays=3 窗口内，不被回填超窗剪枝排除）。
      [args.title, rawId, String(args.importance ?? 90), REAL_NOW],
    );
    return rows[0]!.event_id;
  }

  /** 告警 scan opts（真实 now，不用上面套件的 2098 锚点；其余沿用 opts 默认结构）。 */
  const bfOpts = (over: Record<string, unknown> = {}) => ({
    now: REAL_NOW,
    dbh: db!,
    channels: ['telegram'] as const,
    lock: { redis: memoryRedis(), ttlMs: 60_000 },
    log: () => {},
    windowDays: WINDOW_DAYS,
    maxPerScan: 100,
    collect: { collectors: collectorsReturning([]) }, // 不采新条目，只回填 + 选既有 seed。
    judge: { judge: { generateObjectFn: judgeMock(90), logError: () => {} }, logError: () => {} },
    threshold: 85,
    publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
    ...over,
  });

  it('NULL published_at 达阈值事件经回填后进入候选并被告警', async () => {
    const id = await seedNullDateScoredEvent({ title: 'Backfill alert candidate' });
    const sender = okSender();
    const result = await runAlertScan(
      bfOpts({
        senders: { telegram: sender },
        publishedAtInfer: { generateObjectFn: async () => ({ object: { publishedAt: IN_WINDOW_ISO } }), maxAttempts: 1 },
      }),
    );

    expect(result.alertCandidateCount).toBe(1); // 回填后入候选。
    expect(sender.calls).toBe(1); // 被告警。

    // 库内确认该事件 published_at 已回填为窗口内日期（非 NULL）。
    const { rows } = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events WHERE event_id = $1`,
      [id],
    );
    expect(rows[0]!.published_at).not.toBeNull();
  });

  it('AI 判不出（推断 null）→ 保持 NULL → 被时效闸排除（不告警）', async () => {
    const id = await seedNullDateScoredEvent({ title: 'Undeterminable alert' });
    const sender = okSender();
    const result = await runAlertScan(
      bfOpts({
        senders: { telegram: sender },
        publishedAtInfer: { generateObjectFn: async () => ({ object: { publishedAt: null } }), maxAttempts: 1 },
      }),
    );

    expect(result.alertCandidateCount).toBe(0); // NULL → 时效闸排除。
    expect(sender.calls).toBe(0); // 不告警。
    // 库内确认 published_at 仍为 NULL（未臆造回填）。
    const { rows } = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events WHERE event_id = $1`,
      [id],
    );
    expect(rows[0]!.published_at).toBeNull();
  });

  it('回填失败（推断抛错）不阻塞后续阶段：其余正常告警照常完成', async () => {
    // 一条 NULL published_at（回填抛错降级为 NULL → 排除）；
    // 一条 published_at 在窗口内的正常达阈值事件（不进回填域、照常告警）。
    await seedNullDateScoredEvent({ title: 'Backfill failing alert' });
    const okId = await seedScoredEvent({
      title: 'Healthy alert',
      publishedAt: new Date(REAL_NOW.getTime() - 24 * 60 * 60 * 1000), // 窗口内。
      firstSeenAt: REAL_NOW,
    });
    const sender = okSender();
    const result = await runAlertScan(
      bfOpts({
        senders: { telegram: sender },
        // 推断抛错 → inferPublishedAt 内部降级 null → 该 NULL 事件保持 NULL；不抛断流水线。
        publishedAtInfer: { generateObjectFn: async () => { throw new Error('infer boom'); }, maxAttempts: 1, logError: () => {} },
      }),
    );

    // 流水线未被回填失败阻塞：正常事件照常告警（候选 = 1，即 okId）。
    expect(result.alertCandidateCount).toBe(1);
    expect(sender.calls).toBe(1);
    // 确认被告警的是健康事件 okId（回填失败的 NULL 事件被排除、未阻塞 okId）。
    expect(result.dispatched.some((d) => d.eventId === okId && d.outcome === 'sent')).toBe(true);
    // okId 已落 alert(success) 记录（healthy 事件全程未被回填失败阻塞）。
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM push_records WHERE target_type='alert' AND target_id=$1`,
      [okId],
    );
    expect(rows.map((r) => r.status)).toEqual(['success']);
  });

  it('回填只作用于达阈值的 NULL 事件（未达阈值的 NULL 不进回填域）', async () => {
    // 达阈值（90）的 NULL 事件 → 进回填域、被回填、告警；
    // 未达阈值（80<85）的 NULL 事件 → 不进回填域（回填谓词 importance>=threshold）→ 保持 NULL。
    const aboveId = await seedNullDateScoredEvent({ title: 'Above threshold null', importance: 90 });
    const belowId = await seedNullDateScoredEvent({ title: 'Below threshold null', importance: 80 });
    const sender = okSender();
    const result = await runAlertScan(
      bfOpts({
        senders: { telegram: sender },
        publishedAtInfer: { generateObjectFn: async () => ({ object: { publishedAt: IN_WINDOW_ISO } }), maxAttempts: 1 },
      }),
    );

    // 只有达阈值的那条被回填 + 告警。
    expect(result.alertCandidateCount).toBe(1);
    expect(sender.calls).toBe(1);
    // 达阈值的被回填（非 NULL）；未达阈值的不进回填域（仍 NULL）。
    const above = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events WHERE event_id = $1`, [aboveId]);
    const below = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events WHERE event_id = $1`, [belowId]);
    expect(above.rows[0]!.published_at).not.toBeNull();
    expect(below.rows[0]!.published_at).toBeNull();
  });
});
