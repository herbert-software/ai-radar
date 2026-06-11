/**
 * runDailyWorkflow 端到端编排 + 降级熔断集成测试（任务 10.4，design D7/D8）。
 * 需本地 Postgres + Redis（compose 起的）。mock 注入 LLM（judge/digest 的 generateObject）
 * 与 sender，实跑 collect→store→collapse→judge→topN→digest→push 整链，断言熔断/不熔断/告警分支。
 *
 * 覆盖场景（逐条对齐 10.4）：
 * - 个别条目降级整批继续（仍正常推送）。
 * - judge 阶段超阈值即中止（抛 WorkflowAbortError，不推）。
 * - 摘要阶段超阈值即中止（摘要少量失败不被 judge 大分母稀释——judge 全过、摘要全挂仍中止）。
 * - judge 分母 = 0 但有已评分常青候选时仍正常推送（不误判今日无候选中止）。
 * - 采集返回 = 0 → 告警；采集 > 0 但全 unprocessable → 告警；全命中既有事件正常无新闻日不误告警。
 *
 * 缺 DATABASE_URL / REDIS_URL 时整套件自动跳过。用唯一 source/dedup_key/event 前缀隔离，afterEach 清理。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import * as schema from '../../db/schema.js';
import type { CollectedItem } from '../../collectors/types.js';
import type { MessageSender } from '../../push/dispatcher.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';

const { runDailyWorkflow, WorkflowAbortError } = await import(
  '../run-daily-workflow.js'
);

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const canRun = Boolean(databaseUrl && redisUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const SOURCE = 'pipeline-itest';
// ⚠️ 勿与 npm run smoke / worker 等真实 workflow **并发**跑本测试：跨进程同时写真实今日
// 数据/锁无法纯靠测试文件根治；本文件消除「共享真实今日锁 key」这个最致命点（见下）+ 进程内 TRUNCATE 隔离。
//
// NOW 用**固定的过去锚点**而非真实今日：
// - 锁 key = `daily-digest:2000-01-01`（getPushDate(NOW) 的上海日期），永不与真实今日 workflow
//   的 `daily-digest:{真实今日}` 锁冲突 → 不再被并发真实 workflow 持锁挤成 skipped-locked。
// - 为何用「过去」而非「远未来 2099」：塌缩写入的 first_seen_at 由产品代码硬编码为真实 now()
//   （collapse.ts，不可注入、不许动产品代码），候选窗口是 `first_seen_at >= NOW − N 天`（无上界）。
//   过去锚点使窗口下界落在真实今日之前 → 真实今日塌缩事件仍在窗口内、Top N 不空；
//   而 2099 会把窗口下界推到 2099，真实今日（2026）塌缩事件落窗口外 → Top N 永远空 → 断言挂。
// - cleanup 的 Redis key 模式同步为 `daily-digest:2000-*`，确保能命中本锚点的锁残留。
const NOW = new Date('2000-01-01T03:00:00Z');

/** 注入用：跳过续租、短 TTL（每用例独占 push_date，不会互相挡锁）。 */
const LOCK_OPTS = { ttlMs: 30_000, renewIntervalMs: 0 };

/** 本套件 event 的 representative_title 可读标记（隔离已由 beforeEach 全表 TRUNCATE 保证）。 */
const TITLE_MARKER = '[PITEST]';

/**
 * 构造一个 CollectedItem（rss 源），source_item_id 唯一隔离。
 * 标题统一带 TITLE_MARKER 仅为可读性；表隔离靠 beforeEach 全表 TRUNCATE。
 */
function item(args: {
  id: string;
  url: string | null;
  title: string;
}): CollectedItem {
  return {
    source: 'rss',
    sourceItemId: `${SOURCE}-${args.id}`,
    url: args.url,
    title: `${TITLE_MARKER} ${args.title}`,
    content: null,
    publishedAt: new Date('2099-02-28T00:00:00Z'),
    rawType: 'news',
  };
}

/** 注入 collector：rss 返回给定条目，hn/github 返回空（或全挂）。 */
function collectorsReturning(items: CollectedItem[]) {
  return {
    rss: async () => items,
    hackerNews: async () => [],
    github: async () => [],
  };
}

/** 注入 collector：三源全挂（reject）→ 采集返回 0。 */
function collectorsAllFail() {
  return {
    rss: async () => {
      throw new Error('rss down');
    },
    hackerNews: async () => {
      throw new Error('hn down');
    },
    github: async () => {
      throw new Error('gh down');
    },
  };
}

/** judge generateObject mock：按 title 决定成功（高分 should_push）或失败（抛错触发降级）。 */
function judgeMock(opts: { failTitles?: Set<string>; importance?: number } = {}) {
  return async (args: { prompt: string }) => {
    // prompt 里含「标题：<title>」；用是否命中 failTitles 决定成败。
    const failHit = opts.failTitles
      ? [...opts.failTitles].some((t) => args.prompt.includes(t))
      : false;
    if (failHit) throw new Error('judge llm boom');
    return {
      object: {
        is_ai_related: true,
        type: 'news',
        category: 'AI',
        importance: opts.importance ?? 90,
        novelty: 80,
        developer_relevance: 80,
        hype_risk: 10,
        should_push: true,
        reason: 'ok',
      },
    };
  };
}

/** digest generateObject mock：按 title 决定成功或失败（抛错触发降级回退）。 */
function digestMock(opts: { failTitles?: Set<string> } = {}) {
  return async (args: { prompt: string }) => {
    const failHit = opts.failTitles
      ? [...opts.failTitles].some((t) => args.prompt.includes(t))
      : false;
    if (failHit) throw new Error('digest llm boom');
    return {
      object: { summary_zh: '这是一段中文摘要。', headline_zh: '一句话要点。' },
    };
  };
}

function okSender(): MessageSender & { calls: number } {
  const s = {
    calls: 0,
    async send() {
      s.calls += 1;
    },
  };
  return s;
}

async function cleanup() {
  if (!pool) return;
  // 全表清空（而非仅删 TITLE_MARKER 行）：scoreUnscoredEvents 扫全表 `importance_score IS NULL`、
  // selectTopN 扫全表候选——都不带本套件 marker 过滤。配合 vitest fileParallelism=false（同进程串行），
  // TRUNCATE 三张表确保全局表读只看到本用例 seed 的数据，外部残留的未评分/候选行不会混入断言。
  await pool.query(
    `TRUNCATE TABLE push_records, ai_news_events, raw_items RESTART IDENTITY`,
  );
  if (redisUrl) {
    const r = new Redis(redisUrl);
    // 锚点 NOW=2000-01-01 → 锁 key 形如 `daily-digest:2000-01-01`；清掉本锚点的锁残留。
    const keys = await r.keys('daily-digest:2000-*');
    if (keys.length) await r.del(...keys);
    r.disconnect();
  }
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!canRun)('runDailyWorkflow 编排 + 降级熔断（10.4）', () => {
  it('个别条目降级整批继续：judge 一条失败、其余成功 → 正常推送', async () => {
    const items = [
      item({ id: 'a1', url: 'https://ex.com/a1', title: 'Good news one' }),
      item({ id: 'a2', url: 'https://ex.com/a2', title: 'Good news two' }),
      item({ id: 'a3', url: 'https://ex.com/a3', title: 'BAD judge item' }),
    ];
    const sender = okSender();
    const alert = vi.fn();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock({ failTitles: new Set(['BAD judge item']) }), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender,
      lock: LOCK_OPTS,
      alert,
    });

    // judge 分母 3、降级 1 → 1/3 ≈ 0.33 < 0.5 → 不中止，整批继续。
    expect(result.judge).toEqual({ processed: 3, degraded: 1 });
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
    // 成功的两条进 Top N（第三条未评分不入候选）。
    expect(result.topNCount).toBe(2);
  });

  it('judge 阶段超阈值即中止（抛 WorkflowAbortError，不推）', async () => {
    const items = [
      item({ id: 'j1', url: 'https://ex.com/j1', title: 'BAD a' }),
      item({ id: 'j2', url: 'https://ex.com/j2', title: 'BAD b' }),
      item({ id: 'j3', url: 'https://ex.com/j3', title: 'good c' }),
    ];
    const sender = okSender();
    const alert = vi.fn();
    // 3 条送判、2 条降级 = 0.67 > 0.5 → 中止。
    await expect(
      runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock({ failTitles: new Set(['BAD a', 'BAD b']) }), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        lock: LOCK_OPTS,
        alert,
      }),
    ).rejects.toBeInstanceOf(WorkflowAbortError);
    expect(sender.calls).toBe(0); // 不推残缺日报。
    expect(alert).toHaveBeenCalled();
  });

  it('摘要阶段超阈值即中止（judge 全过、摘要全挂 → 不被 judge 大分母稀释）', async () => {
    // judge 全部成功（大分母、0 降级）；摘要全部失败（小分母、全降级）。
    // 若两阶段合并计算，摘要少量失败会被 judge 大分母稀释 → 不中止（错误）。分开则中止。
    const items = [
      item({ id: 'd1', url: 'https://ex.com/d1', title: 'topic one' }),
      item({ id: 'd2', url: 'https://ex.com/d2', title: 'topic two' }),
    ];
    const sender = okSender();
    const alert = vi.fn();
    await expect(
      runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        // 摘要对所有 Top N 失败（failTitles 命中两条标题）→ 摘要分母 2、降级 2 = 1.0 > 0.5。
        digest: { generateObjectFn: digestMock({ failTitles: new Set(['topic one', 'topic two']) }), maxAttempts: 1 },
        sender,
        lock: LOCK_OPTS,
        alert,
      }),
    ).rejects.toBeInstanceOf(WorkflowAbortError);
    expect(sender.calls).toBe(0);
    expect(alert).toHaveBeenCalled();
  });

  it('judge 分母 = 0 但有已评分常青候选 → 正常推送（不误判今日无候选中止）', async () => {
    // 本轮采集一条会塌缩进「既有已评分常青事件」的条目，使本轮无未评分事件（judge 分母 = 0）。
    // 做法：先算采集 URL 的规范化 dedup_key，把一条已评分常青 event 的 dedup_key 设成它，
    // 这样采集条目塌缩时命中既有事件（ON CONFLICT DO UPDATE，不新建未评分事件）。
    const url = 'https://evergreen.example.com/post/1';
    const { sha256Hex, normalizeUrl } = await import('../../dedup/normalize.js');
    const dedupKey = sha256Hex(normalizeUrl(url)!);

    const { rows } = await pool!.query<{ event_id: string }>(
      `INSERT INTO ai_news_events
         (dedup_key, representative_title, representative_raw_item_id, should_push,
          importance_score, novelty_score, developer_relevance_score, hype_risk_score,
          first_seen_at, source_count)
       VALUES ($1,$2,NULL,true,90,80,80,10,$3,1) RETURNING event_id`,
      // first_seen_at 用真实 now()，落在候选窗口 now − N 天内（与塌缩事件口径一致）。
      [dedupKey, `${TITLE_MARKER} Evergreen scored event`, new Date()],
    );
    // 常青 event 由 beforeEach/afterEach 全表 TRUNCATE 清除（含 rep_raw_item_id 为 NULL 的孤儿行）。
    void rows;

    const sender = okSender();
    const alert = vi.fn();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([item({ id: 'ev', url, title: 'Evergreen rearrival' })]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender,
      lock: LOCK_OPTS,
      alert,
    });

    // judge 分母 = 0（采集条目塌缩进既有已评分事件，无未评分事件）。
    expect(result.judge.processed).toBe(0);
    // 不告警（采集 > 0、可处理 > 0），不中止；常青事件正常进 Top N 并推送。
    expect(result.alerted).toBe(false);
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
  });

  it('采集返回 = 0（三源全挂）→ 告警，不推', async () => {
    const sender = okSender();
    const alert = vi.fn();
    // 本用例不造任何 event；beforeEach 已清库 + 串行执行（vitest fileParallelism=false）
    // 保证无残留候选，故「无候选 → 不推」确定性成立。
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsAllFail() },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender,
      lock: LOCK_OPTS,
      alert,
    });
    expect(result.collectedCount).toBe(0);
    expect(result.alerted).toBe(true);
    expect(alert).toHaveBeenCalled();
    expect(sender.calls).toBe(0); // 三源全挂、无候选 → 不推残缺日报。
  });

  it('采集 > 0 但全 unprocessable → 告警', async () => {
    // 无 URL 且标题仅 emoji/标点 → 归一为空串 → unprocessable。
    // 不用 item()（其 TITLE_MARKER 含字母 "PITEST" 会被归一成非空标题而变可处理）；
    // 直接构造纯 emoji/标点标题。unprocessable 不产生 event，raw_items 按 source_item_id 前缀清理。
    const unproc = (id: string, title: string): CollectedItem => ({
      source: 'rss',
      sourceItemId: `${SOURCE}-${id}`,
      url: null,
      title,
      content: null,
      publishedAt: null,
      rawType: 'news',
    });
    const items = [unproc('u1', '🚀🚀！！！'), unproc('u2', '✨———')];
    const sender = okSender();
    const alert = vi.fn();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender,
      lock: LOCK_OPTS,
      alert,
    });
    expect(result.collectedCount).toBe(2);
    expect(result.processableCount).toBe(0);
    expect(result.alerted).toBe(true);
    expect(sender.calls).toBe(0);
  });

  it('dispatch 前租约已失（isHeld=false）→ 抛错触发重试，不静默 skipped，不推', async () => {
    // 注入 RedisLike：SET NX 成功（拿到锁），但看门狗续租（eval RENEW）恒返 0（令牌不匹配/键已失）
    // → leaseLost 置真 → isHeld() 返 false。配 renewIntervalMs=1ms：collapse/judge/digest 阶段
    // 的真实 DB+LLM-mock await 给事件循环足够间隙让续租定时器先于 dispatch 前的 isHeld() 检查触发。
    const leaseLosingRedis = {
      async set(): Promise<'OK' | null> {
        return 'OK'; // 成功获取锁。
      },
      async eval(): Promise<unknown> {
        return 0; // 续租与释放都返 0：续租→判定租约已失；释放→未删他人锁（安全）。
      },
    };
    const items = [
      item({ id: 'll1', url: 'https://ex.com/ll1', title: 'Lease lost one' }),
      item({ id: 'll2', url: 'https://ex.com/ll2', title: 'Lease lost two' }),
    ];
    const sender = okSender();
    const alert = vi.fn();
    await expect(
      runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        lock: { redis: leaseLosingRedis, ttlMs: 30_000, renewIntervalMs: 1 },
        alert,
      }),
    ).rejects.toThrow(/lease lost/);
    // 绝不返回成功的 skipped-no-candidates；绝不推送；告警一次。
    expect(sender.calls).toBe(0);
    expect(alert).toHaveBeenCalled();
  });

  it('全命中既有事件的正常无新闻日 → 不误告警', async () => {
    // 第一次跑：采集两条新条目并推送（建立既有事件 + 已 success 记录）。
    const url1 = 'https://news.example.com/x1';
    const url2 = 'https://news.example.com/x2';
    const first = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: {
        collectors: collectorsReturning([
          item({ id: 'n1', url: url1, title: 'Day one A' }),
          item({ id: 'n2', url: url2, title: 'Day one B' }),
        ]),
      },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender: okSender(),
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(first.outcome).toBe('pushed');

    // 第二次跑（同一天，重新抓到同样两条 = 全命中既有事件，无新事件）：
    // 用不同 source_item_id（模拟重新抓取的新行）但同 URL → 塌缩进既有事件 → 可处理 > 0。
    const alert = vi.fn();
    const sender = okSender();
    const second = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: {
        collectors: collectorsReturning([
          item({ id: 'n1b', url: url1, title: 'Day one A again' }),
          item({ id: 'n2b', url: url2, title: 'Day one B again' }),
        ]),
      },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender,
      lock: LOCK_OPTS,
      alert,
    });

    // 可处理数 > 0（塌缩进既有事件），不告警。
    expect(second.processableCount).toBe(2);
    expect(second.alerted).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    // 既有事件本日已 success（第一次推过）→ 待发集合为空 → 不重发。
    expect(sender.calls).toBe(0);
    expect(second.outcome).toBe('skipped-no-candidates');
  });
});
