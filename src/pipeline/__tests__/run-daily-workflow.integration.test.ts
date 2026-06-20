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
// 产品段零件模块（供 vi.spyOn 注入塌缩/候选桩，验证日报产品段编排：塌缩只调一次、候选失败降级等）。
const productDigestModule = await import('../product-digest.js');
// 已校验 env（可变对象，非 frozen）：6.1 off-switch 用例临时改 SEMANTIC_DEDUP_ENABLED 后还原。
const { env } = await import('../../config/env.js');

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
// - 候选窗口已由 first_seen_at 改键于 published_at（闭区间 lowerBound <= published_at <= NOW）：
//   下界 ≈ NOW − (FIRST_SEEN_WINDOW_DAYS-1) 个上海自然日 00:00，上界 = NOW（拦未来日期）。
//   故 fixture 的 published_at 必须落在该闭区间内（见 item() 的 2000-01-01T00:00Z），且 NOW 必须
//   ≥ fixture published_at（否则被未来上界 lte(published_at, NOW) 排除）。NOW=2000-01-01T03:00Z 配
//   item() published_at=2000-01-01T00:00Z 满足闭区间 → 「应被推送」fixture 入候选、Top N 不空。
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
    // published_at 须落在候选窗口闭区间 [startOfDayInTimeZone(NOW, FIRST_SEEN_WINDOW_DAYS-1), NOW] 内：
    // 候选窗口键已由 first_seen_at 改为 published_at（含未来上界 lte(published_at, NOW)）。NOW=2000-01-01T03:00Z
    // → 下界 ≈ 1999-12-29T16:00Z、上界 = NOW。取 NOW 当天 00:00Z（在窗口内、不越未来上界），使「应被推送」
    // 的 fixture 恢复入候选。旧值 2099-02-28 相对 NOW(2000) 是未来日期，被新上界排除。
    publishedAt: new Date('2000-01-01T00:00:00Z'),
    rawType: 'news',
  };
}

/**
 * 构造一个 published_at 为 NULL 的 CollectedItem（rss 源）——用于发布时间回填用例：
 * 采集阶段无发布时间 → 塌缩后事件 published_at 为 NULL → 须经回填阶段 AI 推断补值才能入候选。
 */
function nullDateItem(args: {
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
    publishedAt: null,
    rawType: 'news',
  };
}

/**
 * published-at-inference 的 generateObject mock：返回固定 publishedAt（ISO 串或 null）。
 * - 返回窗口内 ISO 串 → 回填成功 → 事件入候选。
 * - 返回 null → AI 判不出 → 事件保持 NULL → 被时效闸排除。
 * - throwOn=true → 抛错（模拟 LLM 调用失败，inferPublishedAt 内部降级为 null，不阻塞流水线）。
 */
function inferMock(opts: { publishedAt: string | null; throwError?: boolean }) {
  return async () => {
    if (opts.throwError) throw new Error('infer llm boom');
    return { object: { publishedAt: opts.publishedAt } };
  };
}

/** 注入 collector：rss 返回给定条目，hn/github/arxiv/product_hunt/show_hn 返回空（或全挂）。 */
function collectorsReturning(items: CollectedItem[]) {
  return {
    rss: async () => items,
    hackerNews: async () => [],
    github: async () => [],
    // arXiv / Product Hunt / Show HN 自 P2 起进 registry；测试用空桩，避免落到真实
    // OAI-PMH / PH GraphQL / HN Algolia 网络调用（带真实 token 时会拉到真数据污染断言）。
    arxiv: async () => [],
    productHunt: async () => [],
    showHn: async () => [],
    // add-tier1-ai-sources 两新源（HF Papers / sitemap）：空桩，避免落真实 HF JSON API / sitemap 网络。
    hfPapers: async () => [],
    sitemap: async () => [],
    // add-ai-blogger-experience-mining：blogger 空桩，避免落真实 BLOGGER_FEEDS / YouTube 字幕网络。
    blogger: async () => [],
  };
}

/** 注入 collector：全部源全挂（reject）→ 采集返回 0。 */
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
    arxiv: async () => {
      throw new Error('arxiv down');
    },
    productHunt: async () => {
      throw new Error('ph down');
    },
    showHn: async () => {
      throw new Error('show_hn down');
    },
    hfPapers: async () => {
      throw new Error('hf_papers down');
    },
    sitemap: async () => {
      throw new Error('sitemap down');
    },
    blogger: async () => {
      throw new Error('blogger down');
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

/** 失败发送器：抛错（dispatcher 据此该通道整批 failed）。 */
function failSender(message = 'channel boom'): MessageSender & { calls: number } {
  const s = {
    calls: 0,
    async send(): Promise<void> {
      s.calls += 1;
      throw new Error(message);
    },
  };
  return s;
}

/** 注入 collector：arxiv 返回 paper 条目（collapsed=true、rawType=paper），新闻三源全空。 */
function collectorsArxivPaperOnly(papers: CollectedItem[]) {
  return {
    rss: async () => [],
    hackerNews: async () => [],
    github: async () => [],
    arxiv: async () => papers,
    productHunt: async () => [],
    showHn: async () => [],
    hfPapers: async () => [],
    sitemap: async () => [],
  };
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
      channels: ['telegram'],
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
        channels: ['telegram'],
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
        channels: ['telegram'],
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
      channels: ['telegram'],
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
      channels: ['telegram'],
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
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert,
    });
    expect(result.collectedCount).toBe(2);
    expect(result.newsProcessableCount).toBe(0);
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
        channels: ['telegram'],
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
      channels: ['telegram'],
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
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert,
    });

    // 新闻类可处理数 > 0（塌缩进既有事件），不告警。
    expect(second.newsProcessableCount).toBe(2);
    expect(second.alerted).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    // 既有事件本日已 success（第一次推过）→ 待发集合为空 → 不重发。
    expect(sender.calls).toBe(0);
    expect(second.outcome).toBe('skipped-no-candidates');
  });

  it('多通道并发分发：向 telegram + feishu 各发一份（5.3/5.4）', async () => {
    const items = [
      item({ id: 'mc1', url: 'https://ex.com/mc1', title: 'Multi channel one' }),
      item({ id: 'mc2', url: 'https://ex.com/mc2', title: 'Multi channel two' }),
    ];
    const tg = okSender();
    const fs = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // 显式两通道 + 各自 mock sender（无需真实 FEISHU env）。
      channels: ['telegram', 'feishu'],
      senders: { telegram: tg, feishu: fs },
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(result.outcome).toBe('pushed');
    expect(tg.calls).toBe(1);
    expect(fs.calls).toBe(1); // 飞书各发一份。

    // 两通道各自一组 success 记录（channel 独立幂等）。
    const { rows } = await pool!.query<{ channel: string; n: string }>(
      `SELECT channel, count(*) AS n FROM push_records
        WHERE target_type='event' AND status='success' GROUP BY channel ORDER BY channel`,
    );
    expect(rows.map((r) => r.channel)).toEqual(['feishu', 'telegram']);
    for (const r of rows) expect(Number(r.n)).toBe(2);
  });

  it('单通道失败隔离：飞书失败不拖垮 telegram；整 job 抛错触发重试（5.3/5.4）', async () => {
    const items = [
      item({ id: 'iso1', url: 'https://ex.com/iso1', title: 'Isolation one' }),
    ];
    const tg = okSender();
    const fs = failSender('feishu webhook down');
    // 飞书发送失败 → 该通道 failed 隔离；telegram 仍 success；整 job 抛错（触发 BullMQ 重试失败通道）。
    await expect(
      runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        channels: ['telegram', 'feishu'],
        senders: { telegram: tg, feishu: fs },
        lock: LOCK_OPTS,
        alert: vi.fn(),
      }),
    ).rejects.toThrow(/dispatch failed/);
    // telegram 照常完成（不被飞书失败拖垮）。
    expect(tg.calls).toBe(1);
    expect(fs.calls).toBe(1);

    const { rows } = await pool!.query<{ channel: string; status: string }>(
      `SELECT channel, status FROM push_records
        WHERE target_type='event' ORDER BY channel`,
    );
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r.status]));
    expect(byChannel.telegram).toBe('success'); // 隔离：telegram 成功。
    expect(byChannel.feishu).toBe('failed'); // 飞书该批 failed（下次重试）。
  });

  it('纯 Telegram 部署（未配/未启用飞书）→ 只向 telegram 分发，照常启动推送（向后兼容）', async () => {
    const items = [
      item({ id: 'tgonly', url: 'https://ex.com/tgonly', title: 'Telegram only' }),
    ];
    const tg = okSender();
    // 显式注入 channels=['telegram'] 模拟「飞书未配置」解析结果——确定性、不依赖测试进程的
    // ambient FEISHU env（开发者本地 .env 可能配了飞书）。env→通道集解析（isFeishuEnabled
    // 真/假）由 env.test.ts 单测覆盖；本集成测试验证「通道集仅 telegram → 只发 telegram、
    // push_records 无 feishu 行」的向后兼容分发路径。
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender: tg,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(result.outcome).toBe('pushed');
    expect(tg.calls).toBe(1);
    // 只有 telegram channel 的记录，无 feishu 行。
    const { rows } = await pool!.query<{ channel: string }>(
      `SELECT DISTINCT channel FROM push_records WHERE target_type='event'`,
    );
    expect(rows.map((r) => r.channel)).toEqual(['telegram']);
  });

  it('仅 arXiv 返回 paper、新闻源全空 → 仍按新闻真空告警（5.7）', async () => {
    // arXiv 论文 rawType='paper'、collapsed=true：不进新闻事件塌缩、不计入新闻类可处理数。
    // 新闻三源全空 → newsProcessableCount=0、collectedCount>0 → 必须照常「新闻真空」告警。
    const papers: CollectedItem[] = [
      {
        source: 'arxiv',
        sourceItemId: `${SOURCE}-paper-1`,
        url: 'https://arxiv.org/abs/2401.00001',
        title: `${TITLE_MARKER} A paper`,
        content: null,
        publishedAt: null,
        rawType: 'paper',
        collapsed: true,
      },
    ];
    const sender = okSender();
    const alert = vi.fn();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsArxivPaperOnly(papers) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert,
    });
    expect(result.collectedCount).toBe(1); // paper 计入采集返回数。
    expect(result.newsProcessableCount).toBe(0); // paper 不计入新闻类可处理数。
    expect(result.alerted).toBe(true); // 新闻真空告警照常触发，不被 paper 掩盖。
    expect(alert).toHaveBeenCalled();
    expect(sender.calls).toBe(0); // 无新闻候选 → 不推。
  });
});

/** 内存 Redis 桩：SET NX PX + 「核对令牌再删」eval，供回填 per-event 锁注入（不依赖真实 Redis）。 */
function memoryRedis(): import('../../push/lock.js').RedisLike {
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

/**
 * 任务 4.4（fix-push-recency-by-published-at）：日报链发布时间回填阶段编排集成测试。
 *
 * 回填阶段在 Value Judge 之后、Top N 之前对「should_push=true 且 published_at IS NULL」的事件
 * 调 published-at-inference（mock 注入 generateObjectFn 控制推断结果）。断言：
 * - NULL published_at 事件经回填（推断窗口内日期）后入候选并被推送。
 * - AI 判不出（推断 null）→ 事件保持 NULL → 被时效闸排除（不推）。
 * - 回填失败（推断抛错）不阻塞后续阶段（其余正常事件照常完成）。
 * - 回填阶段确在 Value Judge 之后（只作用于已评分 should_push=true 的 NULL 事件）。
 * - 回填高「判不出」率不触发 DEGRADE_ABORT_RATIO 误熔断（构造高判不出批，断言不抛/不中止）。
 *
 * 回填锁注入内存 Redis（memoryRedis）以确定性化、不依赖真实 Redis 锁残留。
 */
describe.skipIf(!canRun)('runDailyWorkflow 发布时间回填阶段（4.4）', () => {
  // 回填推断 mock 须返回落在候选窗口闭区间内的 ISO（NOW=2000-01-01T03:00Z，下界 ≈ 1999-12-29T16:00Z）。
  const IN_WINDOW_ISO = '2000-01-01T00:00:00.000Z';

  it('NULL published_at 事件经回填（推断窗口内日期）后进入候选并被推送', async () => {
    const items = [
      nullDateItem({ id: 'bf1', url: 'https://ex.com/bf1', title: 'Backfilled news' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // 推断返回窗口内日期 → 回填成功 → 事件入候选。
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: IN_WINDOW_ISO }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    expect(result.publishedAtBackfill?.backfilled).toBe(1); // 回填一条。
    expect(result.topNCount).toBe(1); // 回填后入候选。
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);

    // 库内确认该事件 published_at 已被回填为窗口内日期（非 NULL）。
    const { rows } = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.published_at).not.toBeNull();
  });

  it('AI 判不出（推断返回 null）→ 事件保持 NULL → 被时效闸排除（不推）', async () => {
    const items = [
      nullDateItem({ id: 'und1', url: 'https://ex.com/und1', title: 'Undeterminable news' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // 推断返回 null → 判不出 → 保持 NULL → 被候选窗口排除。
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: null }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    expect(result.publishedAtBackfill?.attempted).toBe(1);
    expect(result.publishedAtBackfill?.backfilled).toBe(0);
    expect(result.publishedAtBackfill?.undetermined).toBe(1); // 判不出一条。
    expect(result.topNCount).toBe(0); // NULL → 时效闸排除 → 不入候选。
    expect(result.outcome).toBe('skipped-no-candidates');
    expect(sender.calls).toBe(0);

    // 库内确认该事件 published_at 仍为 NULL（未臆造回填）。
    const { rows } = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events`,
    );
    expect(rows[0]!.published_at).toBeNull();
  });

  it('回填失败（推断抛错）不阻塞后续阶段：其余正常事件照常推送', async () => {
    // 一条 NULL published_at 事件（回填会抛错降级为 NULL → 被排除）；
    // 一条采集即带窗口内 published_at 的正常事件（不进回填域、照常入候选推送）。
    const items = [
      nullDateItem({ id: 'fail1', url: 'https://ex.com/fail1', title: 'Backfill failing news' }),
      item({ id: 'ok1', url: 'https://ex.com/ok1', title: 'Healthy news' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // 推断抛错 → inferPublishedAt 内部降级为 null → 该 NULL 事件保持 NULL；不抛断流水线。
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: null, throwError: true }), maxAttempts: 1, logError: () => {} },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // 回填阶段尝试了那条 NULL 事件、判不出（推断降级 null），但不抛断；正常事件照常完成。
    expect(result.publishedAtBackfill?.attempted).toBe(1); // 仅 NULL 事件进回填域。
    expect(result.publishedAtBackfill?.backfilled).toBe(0); // 抛错降级 → 未回填。
    expect(result.outcome).toBe('pushed'); // 流水线未被阻塞，正常事件推送。
    expect(result.topNCount).toBe(1); // 仅采集即带日期的正常事件入候选。
    expect(sender.calls).toBe(1);
  });

  it('回填只作用于已评分 should_push=true 的 NULL 事件（在 Value Judge 之后）', async () => {
    // 一条 NULL published_at 但 judge 失败（未评分 → should_push 非 true）的事件：
    // 因 judge 失败该事件无 should_push=true → 不进回填域（证明回填在评分后、只覆盖已评分 should_push）。
    // 另一条 NULL published_at 且 judge 成功（should_push=true）的事件：进回填域、被回填。
    const items = [
      nullDateItem({ id: 'unscored', url: 'https://ex.com/unscored', title: 'BAD unscored item' }),
      nullDateItem({ id: 'scored', url: 'https://ex.com/scored', title: 'Good scored item' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      // 'BAD unscored item' judge 失败（未评分、无 should_push）；'Good scored item' 成功（should_push=true）。
      judge: { judge: { generateObjectFn: judgeMock({ failTitles: new Set(['BAD unscored item']) }), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: IN_WINDOW_ISO }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // judge 分母 2、降级 1 = 0.5（不严格 > 0.5）→ 不中止。
    expect(result.judge).toEqual({ processed: 2, degraded: 1 });
    // 回填只覆盖「评分后 should_push=true」的那一条 NULL 事件（未评分的不进回填域）。
    expect(result.publishedAtBackfill?.attempted).toBe(1);
    expect(result.publishedAtBackfill?.backfilled).toBe(1);
    expect(result.topNCount).toBe(1); // 仅已评分 + 回填成功者入候选。
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
  });

  it('AI 回填出未来/荒谬日期 → schema refine + CAS 上界拒、事件仍 NULL → 被时效闸排除（任务 6.2 反向）', async () => {
    // 端到端反向用例：published-at-inference 的 generateObject 返回**未来**日期（绕过时效闸的攻击面）。
    // 期望：schema refine（合理下限<=date<=now）把越界值归一为 null → inferPublishedAt 返回 null →
    //       事件保持 NULL → Top N 时效闸排除（不被误推）。双层防御的 schema 层 + NULL 排除兜底。
    const items = [
      nullDateItem({ id: 'fut1', url: 'https://ex.com/fut1', title: 'Future dated backfill' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // 推断返回相对 NOW(2000) 的未来日期（2099）→ schema refine 归一 null → 保持 NULL。
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: '2099-01-01T00:00:00Z' }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // 未来日期被 schema refine 拒 → 判不出（undetermined）、未回填 → NULL → 时效闸排除。
    expect(result.publishedAtBackfill?.attempted).toBe(1);
    expect(result.publishedAtBackfill?.backfilled).toBe(0);
    expect(result.publishedAtBackfill?.undetermined).toBe(1);
    expect(result.topNCount).toBe(0); // 未来值不被回填 → NULL → 不入候选。
    expect(result.outcome).toBe('skipped-no-candidates');
    expect(sender.calls).toBe(0); // 不被误推。

    // 库内确认 published_at 仍 NULL（绝不回填越界未来值）。
    const { rows } = await pool!.query<{ published_at: Date | null }>(
      `SELECT published_at FROM ai_news_events`,
    );
    expect(rows[0]!.published_at).toBeNull();
  });

  it('回填→入候选→首推 success→次日同事件全通道 success→移出名单不重推（任务 6.4 幂等交互）', async () => {
    // 验证：回填不破坏「一生一次 success」跨天去重与 UNIQUE 四元组。
    // Day 1：NULL published_at 事件经回填入候选、首推 success。
    // Day 2（next push_date）：同事件 published_at 已非 NULL（回填后冻结）、仍在窗口、should_push=true，
    //        但已全通道 success → 候选窗口「尚未投递给所有通道」排除它 → 移出名单、不重推。
    const url = 'https://ex.com/idem-bf';
    const day1Items = [
      nullDateItem({ id: 'idem-bf', url, title: 'Backfill then idempotent' }),
    ];
    // Day 1：NOW 锚点；回填窗口内日期。
    // channels: ['telegram'] 显式钉死单通道——确定性、不依赖测试进程 ambient FEISHU env（开发者
    // 本地 .env 可能配了飞书，会让默认通道集变成 [telegram, feishu] 而多出一条 success 记录）。
    const s1 = okSender();
    const r1 = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(day1Items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: IN_WINDOW_ISO }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender: s1,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(r1.publishedAtBackfill?.backfilled).toBe(1);
    expect(r1.topNCount).toBe(1);
    expect(r1.outcome).toBe('pushed');
    expect(s1.calls).toBe(1); // 首推 success。

    // 确认事件已落 published_at（回填后冻结）+ 一条 event(success) 记录（Day 1 push_date）。
    const evRows = await pool!.query<{ event_id: string; published_at: Date | null }>(
      `SELECT event_id, published_at FROM ai_news_events`,
    );
    expect(evRows.rows).toHaveLength(1);
    expect(evRows.rows[0]!.published_at).not.toBeNull();
    const day1PushDate = (await import('../../push/push-date.js')).getPushDate(NOW);
    const day1Recs = await pool!.query<{ status: string }>(
      `SELECT status FROM push_records WHERE target_type='event' AND push_date=$1`,
      [day1PushDate],
    );
    expect(day1Recs.rows.map((r) => r.status)).toEqual(['success']);

    // Day 2：next 自然日的 NOW（+1 天），同 URL 重新抓到（不同 source_item_id）。事件 published_at
    // 仍非 NULL（COALESCE/回填后冻结）、仍在 3 天窗口内、should_push=true。但已全通道 success →
    // 候选窗口排除 → 不进 Top N、不重推（一生一次 success 跨天去重 + UNIQUE 四元组）。
    const NOW_DAY2 = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const day2Items = [
      // 同 URL → 塌缩进既有事件（不新建）；published_at 已非 NULL → 不进回填域。
      item({ id: 'idem-bf-d2', url, title: 'Backfill then idempotent again' }),
    ];
    const s2 = okSender();
    const r2 = await runDailyWorkflow({
      now: NOW_DAY2,
      dbh: db!,
      collect: { collectors: collectorsReturning(day2Items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: IN_WINDOW_ISO }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender: s2,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // 回填不破坏跨天去重：事件全通道已 success → 移出统一名单 → 不重推。
    expect(r2.publishedAtBackfill?.attempted).toBe(0); // published_at 已非 NULL → 不进回填域。
    expect(r2.topNCount).toBe(0); // 已全通道 success → 候选窗口排除。
    expect(r2.outcome).toBe('skipped-no-candidates');
    expect(s2.calls).toBe(0); // 不重推（一生一次 success）。

    // UNIQUE 四元组：仍只有 Day 1 一条 event(success)，Day 2 未新增。
    const allEventRecs = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM push_records WHERE target_type='event' AND status='success'`,
    );
    expect(Number(allEventRecs.rows[0]!.n)).toBe(1);
  });

  it('回填高「判不出」率不触发 DEGRADE_ABORT_RATIO 误熔断', async () => {
    // 构造一批 should_push=true 且 published_at NULL 的事件（judge 全过、大分母 0 降级），
    // 回填推断全返回 null（高判不出率 100%）。若回填误计入熔断分母会中止；正确则不中止。
    const items = Array.from({ length: 4 }, (_, i) =>
      nullDateItem({ id: `hd${i}`, url: `https://ex.com/hd${i}`, title: `High undetermined ${i}` }),
    );
    const sender = okSender();
    const alert = vi.fn();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      // judge 全过（分母 4、降级 0）。
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // 回填推断全 null（判不出率 100%）。
      publishedAtInfer: { generateObjectFn: inferMock({ publishedAt: null }), maxAttempts: 1 },
      publishedAtLock: { redis: memoryRedis(), ttlMs: 30_000 },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert,
    });

    // 关键断言：未抛 WorkflowAbortError、outcome 非 'aborted-degrade'。
    expect(result.outcome).not.toBe('aborted-degrade');
    // judge 熔断分母不含回填：judge 全过 0 降级。
    expect(result.judge).toEqual({ processed: 4, degraded: 0 });
    // 回填全判不出（4 条），但仅 log、不熔断、不入任何降级率分母。
    expect(result.publishedAtBackfill?.attempted).toBe(4);
    expect(result.publishedAtBackfill?.undetermined).toBe(4);
    expect(result.publishedAtBackfill?.backfilled).toBe(0);
    // 全部判不出 → NULL 全被时效闸排除 → 无候选，但是「正常 skipped-no-candidates」而非「因回填熔断中止」。
    expect(result.outcome).toBe('skipped-no-candidates');
    expect(result.topNCount).toBe(0);
    expect(sender.calls).toBe(0);
  });
});

/**
 * runDailyWorkflow 产品段编排集成测试（merge-products-into-daily-digest，design D1/D5/D6，tasks 7.3）。
 *
 * 注入产品段两步零件桩（vi.spyOn product-digest 模块的 collapseProductsOnce / selectProductsForChannelSafe）：
 * - 日报含产品段：候选非空 → 推一条含新品段的日报、push_records 出 target_type='product' 行。
 * - 塌缩只调一次（多 channel 下断言 collapse 调用次数 = 1，channel-blind 不随 per-channel 重复）。
 * - 产品段降级空（候选 safe 包装失败返回空）→ 新闻段照推、不进熔断分母（judge/digest 统计不变）。
 * - 早退两段皆空才 skip：新闻空 + 产品非空 / 新闻非空 + 产品空 各正常推单段、两段皆空才 skip。
 * - 汇总按 dispatchDailyDigest 的 outcome（sent → pushed）。
 *
 * 推送均注入 mock sender + 钉 channels（防误发生产飞书，memory test-no-prod-sends）。
 */
describe.skipIf(!canRun)('runDailyWorkflow 产品段编排（7.3）', () => {
  /** 造一个产品候选视图（SelectedEvent，eventId=product_id；无 headline/summary）。 */
  function prodCandidate(productId: string): import('../../selection/top-n.js').SelectedEvent {
    return {
      eventId: productId,
      representativeTitle: `产品候选 ${productId}`,
      summaryZh: null,
      headlineZh: null,
      canonicalUrl: null,
      publishedAt: null,
      rankScore: 0,
    };
  }

  it('日报含产品段：候选非空 → 推含新品段的日报，push_records 出 target_type=product 行', async () => {
    const pid = `prod-seg-${process.pid}-a1`;
    // 塌缩桩：无操作（不连真实产品塌缩）；候选桩：telegram 返回一个产品候选。
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    const candSpy = vi
      .spyOn(productDigestModule, 'selectProductsForChannelSafe')
      .mockResolvedValue([prodCandidate(pid)]);
    try {
      const items = [item({ id: 'pseg1', url: 'https://ex.com/pseg1', title: 'News with product' })];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('pushed');
      expect(sender.calls).toBe(1); // 一条含要闻 + 新品的日报。
      expect(collapseSpy).toHaveBeenCalledTimes(1);

      // push_records 出 product 行 success（产品段并入日报、各按 target_type 写）。
      const { rows } = await pool!.query<{ target_id: string; status: string }>(
        `SELECT target_id, status FROM push_records WHERE target_type='product'`,
      );
      expect(rows.find((r) => r.target_id === pid)?.status).toBe('success');
    } finally {
      collapseSpy.mockRestore();
      candSpy.mockRestore();
    }
  });

  it('塌缩只调一次（多 channel 下 collapse 调用次数 = 1，channel-blind 不随 per-channel 重复）', async () => {
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    // 候选桩：两通道各返回各自候选（断言塌缩在 channel 展开之前只跑一次、候选 per-channel）。
    const candSpy = vi
      .spyOn(productDigestModule, 'selectProductsForChannelSafe')
      .mockImplementation(async (channel) => [prodCandidate(`prod-mc-${process.pid}-${channel}`)]);
    try {
      const items = [item({ id: 'mcollapse', url: 'https://ex.com/mc', title: 'Multi channel collapse' })];
      const tg = okSender();
      const fs = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        channels: ['telegram', 'feishu'],
        senders: { telegram: tg, feishu: fs },
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('pushed');
      // 塌缩 channel-blind 只跑一次（不随 2 个 channel 重复）。
      expect(collapseSpy).toHaveBeenCalledTimes(1);
      // 候选 per-channel：每个 channel 各调一次（共 2 次）。
      expect(candSpy).toHaveBeenCalledTimes(2);
      expect(tg.calls).toBe(1);
      expect(fs.calls).toBe(1);
    } finally {
      collapseSpy.mockRestore();
      candSpy.mockRestore();
    }
  });

  it('产品段降级空（候选 safe 返回空）→ 新闻段照推、不进熔断分母（judge/digest 统计不变）', async () => {
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    // 候选 safe 包装失败时返回空段（设计契约：永不抛、降级空）——此处直接返回空模拟降级结果。
    const candSpy = vi
      .spyOn(productDigestModule, 'selectProductsForChannelSafe')
      .mockResolvedValue([]);
    try {
      const items = [
        item({ id: 'pdeg1', url: 'https://ex.com/pdeg1', title: 'Healthy news A' }),
        item({ id: 'pdeg2', url: 'https://ex.com/pdeg2', title: 'Healthy news B' }),
      ];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      // 新闻段照常推送（产品段空不拖垮）。
      expect(result.outcome).toBe('pushed');
      expect(sender.calls).toBe(1);
      // 熔断分母仅含 judge/digest，与产品段无关：judge 全过、digest 全过。
      expect(result.judge).toEqual({ processed: 2, degraded: 0 });
      expect(result.digest.degraded).toBe(0);
      expect(collapseSpy).toHaveBeenCalledTimes(1);
      void candSpy;
      // 无 product 行写入（产品段空）。
      const { rows } = await pool!.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_records WHERE target_type='product'`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      collapseSpy.mockRestore();
      candSpy.mockRestore();
    }
  });

  it('早退：新闻非空 + 产品空 → 正常推单段（要闻段）', async () => {
    const collapseSpy = vi.spyOn(productDigestModule, 'collapseProductsOnce').mockResolvedValue(undefined);
    const candSpy = vi.spyOn(productDigestModule, 'selectProductsForChannelSafe').mockResolvedValue([]);
    try {
      const items = [item({ id: 'newsonly', url: 'https://ex.com/no', title: 'News only segment' })];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('pushed'); // 仅要闻段，正常推。
      expect(sender.calls).toBe(1);
    } finally {
      collapseSpy.mockRestore();
      candSpy.mockRestore();
    }
  });

  it('早退：新闻空 + 产品非空 → 正常推单段（新品段，不被新闻空吞掉）', async () => {
    const pid = `prod-only-${process.pid}-x1`;
    const collapseSpy = vi.spyOn(productDigestModule, 'collapseProductsOnce').mockResolvedValue(undefined);
    const candSpy = vi
      .spyOn(productDigestModule, 'selectProductsForChannelSafe')
      .mockResolvedValue([prodCandidate(pid)]);
    try {
      // 新闻三源全空 → 新闻 Top N 为空；产品候选非空 → 仍须推新品段（design D6 修复「新闻空吞掉产品段」）。
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning([]) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      // 新闻空但产品非空 → 不早退、推新品段。
      expect(result.outcome).toBe('pushed');
      expect(result.topNCount).toBe(0); // 新闻 Top N 空。
      expect(sender.calls).toBe(1); // 仍发一条（仅新品段）。
      // product 行写入 success。
      const { rows } = await pool!.query<{ status: string }>(
        `SELECT status FROM push_records WHERE target_type='product' AND target_id=$1`,
        [pid],
      );
      expect(rows[0]?.status).toBe('success');
    } finally {
      collapseSpy.mockRestore();
      candSpy.mockRestore();
    }
  });

  it('早退：新闻空 + 产品空 → skip-no-candidates（两段皆空才不推）', async () => {
    const collapseSpy = vi.spyOn(productDigestModule, 'collapseProductsOnce').mockResolvedValue(undefined);
    const candSpy = vi.spyOn(productDigestModule, 'selectProductsForChannelSafe').mockResolvedValue([]);
    try {
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning([]) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('skipped-no-candidates');
      expect(sender.calls).toBe(0); // 两段皆空 → 不发空消息。
    } finally {
      collapseSpy.mockRestore();
      candSpy.mockRestore();
    }
  });
});

/**
 * runDailyWorkflow 阶段 5.5 产品中文化编排集成测试（add-product-chinese-digest，design D3/D7，task 8.6）。
 *
 * 验证编排不变量：
 * - 中文化在塌缩（collapseProductsOnce）之后、per-channel 候选（selectProductsForChannelSafe）之前
 *   （调用顺序断言）。
 * - 中文化失败**不中止流水线、不进熔断分母、要闻段不受影响、产品回退英文照常推**：seed 一个真实
 *   未中文化产品候选，让真实 digestPendingProducts 运行 —— 其内部 summarizeProduct 走 buildModel +
 *   defaultGenerateObject，**VITEST 守卫使真实 LLM 路径抛错**（不真调 LLM），逐次重试耗尽 →
 *   ProductDigestFailureError → digestPendingProducts 永不向上抛吞掉 → 产品保持 name_zh NULL →
 *   候选映射回退英文名 → 照常推送；要闻段 judge/digest 统计不受影响。
 *
 * 推送均注入 mock sender + 钉 channels（防误发生产飞书，memory test-no-prod-sends）。
 * ai_products 不在 cleanup 的 TRUNCATE 内，故 seed 的产品用唯一前缀、本块 finally 显式清理。
 */
describe.skipIf(!canRun)('runDailyWorkflow 产品中文化编排（阶段 5.5，8.6）', () => {
  const PROD_PREFIX = `rdw-zh-${process.pid}-`;

  async function cleanupProducts() {
    if (!pool) return;
    await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${PROD_PREFIX}%`]);
    await pool.query(`DELETE FROM ai_products WHERE product_id LIKE $1`, [`${PROD_PREFIX}%`]);
  }

  it('中文化在塌缩之后、per-channel 候选之前（调用顺序断言）', async () => {
    // 三步零件全 spy：断言 collapse → digest → candidates 的相对调用顺序（design D3 位置约束）。
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    const digestSpy = vi
      .spyOn(productDigestModule, 'digestPendingProducts')
      .mockResolvedValue(undefined);
    const candSpy = vi
      .spyOn(productDigestModule, 'selectProductsForChannelSafe')
      .mockResolvedValue([]);
    try {
      const items = [item({ id: 'order1', url: 'https://ex.com/o1', title: 'Order news' })];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('pushed');
      // 三步均被调用，且相对顺序：collapse < digest < candidates（invocationCallOrder 单调递增）。
      const collapseOrder = collapseSpy.mock.invocationCallOrder[0]!;
      const digestOrder = digestSpy.mock.invocationCallOrder[0]!;
      const candOrder = candSpy.mock.invocationCallOrder[0]!;
      expect(collapseOrder).toBeLessThan(digestOrder);
      expect(digestOrder).toBeLessThan(candOrder);
      // 中文化 channel-blind 只调一次（不随 per-channel 重复）。
      expect(digestSpy).toHaveBeenCalledTimes(1);
    } finally {
      collapseSpy.mockRestore();
      digestSpy.mockRestore();
      candSpy.mockRestore();
    }
  });

  it('中文化失败（VITEST 守卫模拟 LLM 不可用）不中止流水线、不进熔断分母、要闻照常、产品回退英文推', async () => {
    await cleanupProducts();
    // seed 一个真实未中文化产品候选（name_zh NULL、无 merge_conflict、从未 success）。
    const pid = `${PROD_PREFIX}fallback`;
    await pool!.query(
      `INSERT INTO ai_products (product_id, name, canonical_domain, last_seen_at)
       VALUES ($1, $2, $3, now())`,
      [pid, `${PROD_PREFIX}EnglishProduct`, `${PROD_PREFIX}prod.example.com`],
    );
    // 塌缩 spy 为 no-op（不让真实塌缩干扰 seed 的产品）；digest / candidates **不 spy** → 走真实路径：
    // 真实 digestPendingProducts 内 summarizeProduct → defaultGenerateObject 在 VITEST 下抛错 →
    // 重试耗尽 → ProductDigestFailureError → 整步吞掉（永不向上抛）→ 产品保持 NULL。
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    try {
      const items = [item({ id: 'fb1', url: 'https://ex.com/fb1', title: 'Healthy news for fallback' })];
      const sender = okSender();
      const alert = vi.fn();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert,
      });
      // 中文化失败不中止流水线：照常 pushed（要闻 + 新品两段都推）。
      expect(result.outcome).toBe('pushed');
      expect(sender.calls).toBe(1);
      // 要闻段不受产品中文化失败影响：judge / digest 统计与无产品时一致（产品失败不进熔断分母）。
      expect(result.judge).toEqual({ processed: 1, degraded: 0 });
      expect(result.digest.degraded).toBe(0);
      // 产品保持 name_zh NULL（中文化失败、不写库）。
      const { rows: prodRows } = await pool!.query<{ name_zh: string | null }>(
        `SELECT name_zh FROM ai_products WHERE product_id = $1`,
        [pid],
      );
      expect(prodRows[0]!.name_zh).toBeNull();
      // 产品仍被推送（回退英文名）：push_records 出该 product 的 success 行。
      const { rows: pushRows } = await pool!.query<{ status: string }>(
        `SELECT status FROM push_records WHERE target_type='product' AND target_id=$1`,
        [pid],
      );
      expect(pushRows[0]?.status).toBe('success');
    } finally {
      collapseSpy.mockRestore();
      await cleanupProducts();
    }
  });
});

/**
 * runDailyWorkflow 语义去重 + 知识库入库阶段接线集成测试
 * （add-semantic-dedup-and-store-hardening，组 F，tasks 6.1/6.2，design D3/D7）。
 *
 * 验证编排接线（不重测组 D/E 内部，已各自单测/集成）：
 * - 6.1 语义阶段在 collapse 之后、value-judge 之前运行：注入 embedManyFn 桩（恒同向量 → cosine_sim=1
 *   > 0.88 → high-auto 合并）使两个**不同 dedup_key（不硬塌缩）但语义同**的事件合并为一条，
 *   被吞者置 merged_into（tombstone），且 tombstone 不被 value-judge 复活、不进 Top N（组 4.7 闭环）。
 * - 6.1 SEMANTIC_DEDUP_ENABLED=off → 跳过语义层（不调 embedManyFn、不合并），其余阶段照常推送。
 * - 6.1 语义降级（embedding 调用抛错）不抛断、不进 judge/digest 熔断分母、不影响 outcome。
 * - 6.2 KB 入库在 push 成功之后运行：注入 KB Agent 桩产出 long_term_value>=70 → 写入 kb_documents；
 *   候选 = 当日 push success 且非 tombstone（被合并掉的事件不进 KB 候选）。
 * - 6.2 KB 阶段异常不影响已成功的 push outcome（防御性 try/catch）。
 *
 * embedding 列为 vector(1536)：注入桩须返回 1536 维向量。kb_documents/kb_ingestion_records 不在
 * 顶部 cleanup 的 TRUNCATE 内，故本块 beforeEach/afterEach 额外清理。推送注入 mock sender + 钉 channels。
 */
describe.skipIf(!canRun)('runDailyWorkflow 语义去重 + 知识库接线（组 F 6.1/6.2）', () => {
  /** 1536 维同向量（任意两事件 cosine_sim=1 → high-auto 合并）。 */
  const ONE_VEC = (() => {
    const v = new Array<number>(1536).fill(0);
    v[0] = 1;
    return v;
  })();

  /** embedMany 桩：对每个文本返回同一单位向量（不触网）。 */
  function embedManySame() {
    return async (args: { values: string[] }) => ({
      embeddings: args.values.map(() => [...ONE_VEC]),
    });
  }

  /** embedMany 桩：恒抛错（模拟 embedding 外部调用失败 → 语义降级为不合并）。 */
  function embedManyFail() {
    return async () => {
      throw new Error('embed boom');
    };
  }

  /** KB Agent generateObject 桩：返回 long_term_value=opts.value 的合法元数据。 */
  function kbAgentMock(opts: { value: number } = { value: 90 }) {
    return async () => ({
      object: {
        kb_title: 'KB 标题',
        summary_zh: '这是一段中文知识摘要。',
        tags: ['AI'],
        entities: ['OpenAI'],
        source_urls: [],
        event_date: '2000-01-01',
        long_term_value: opts.value,
      },
    });
  }

  async function cleanupKb() {
    if (!pool) return;
    await pool.query(`TRUNCATE TABLE kb_documents, kb_ingestion_records RESTART IDENTITY`);
  }

  beforeEach(cleanupKb);
  afterEach(cleanupKb);

  it('6.1 语义阶段合并语义同事件（high-auto），被吞置 tombstone 不被 Top N 重复推送', async () => {
    // 两条**不同 URL（不同 dedup_key → 不硬塌缩）**但语义同的新闻事件；embedManyFn 桩使二者 cosine_sim=1
    // → high-auto 合并为一条。存活者 = first_seen_at 较早者（并列取 event_id 字典序小）。
    const items = [
      item({ id: 'sem-a', url: 'https://ex.com/sem-a', title: 'OpenAI ships GPT' }),
      item({ id: 'sem-b', url: 'https://ex.com/sem-b', title: 'OpenAI releases GPT model' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      semantic: { embedding: { embed: { embedManyFn: embedManySame(), maxAttempts: 1 } } },
      // KB Agent 注入桩（push 后跑 KB；此用例不主断 KB，仅避免默认 VITEST 守卫噪声）。
      kb: { agent: { generateObjectFn: kbAgentMock(), maxAttempts: 1 }, embed: { embedManyFn: embedManySame(), maxAttempts: 1 } },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // 语义阶段确实跑了并合并一次（high-auto）。
    expect(result.semantic).toBeDefined();
    expect(result.semantic!.highAutoMerged).toBe(1);

    // 库内：恰一条 tombstone（merged_into 非空）、一条存活者（merged_into 为 NULL）。
    const { rows: evRows } = await pool!.query<{ event_id: string; merged_into: string | null }>(
      `SELECT event_id, merged_into FROM ai_news_events ORDER BY first_seen_at`,
    );
    expect(evRows).toHaveLength(2);
    const survivors = evRows.filter((r) => r.merged_into === null);
    const tombstones = evRows.filter((r) => r.merged_into !== null);
    expect(survivors).toHaveLength(1);
    expect(tombstones).toHaveLength(1);
    // tombstone 指向存活者。
    expect(tombstones[0]!.merged_into).toBe(survivors[0]!.event_id);

    // tombstone 不被 value-judge 复活 / 不进 Top N → 只推存活者一条（合并核心闭环，组 4.7）。
    expect(result.topNCount).toBe(1);
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
    // 仅存活者一条 event success（tombstone 不推）。
    const { rows: pr } = await pool!.query<{ target_id: string }>(
      `SELECT target_id FROM push_records WHERE target_type='event' AND status='success'`,
    );
    expect(pr).toHaveLength(1);
    expect(pr[0]!.target_id).toBe(survivors[0]!.event_id);
  });

  it('6.1 SEMANTIC_DEDUP_ENABLED=off → 跳过语义层（不调 embed、不合并），其余阶段照常推送', async () => {
    const saved = env.SEMANTIC_DEDUP_ENABLED;
    env.SEMANTIC_DEDUP_ENABLED = 'off';
    const embedSpy = vi.fn(embedManySame());
    try {
      const items = [
        item({ id: 'off-a', url: 'https://ex.com/off-a', title: 'OpenAI ships GPT' }),
        item({ id: 'off-b', url: 'https://ex.com/off-b', title: 'OpenAI releases GPT model' }),
      ];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        semantic: { embedding: { embed: { embedManyFn: embedSpy, maxAttempts: 1 } } },
        kb: { agent: { generateObjectFn: kbAgentMock(), maxAttempts: 1 }, embed: { embedManyFn: embedManySame(), maxAttempts: 1 } },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });

      // off：语义阶段整段跳过（result.semantic undefined、embed 桩未被调用、无合并）。
      expect(result.semantic).toBeUndefined();
      expect(embedSpy).not.toHaveBeenCalled();
      // 两事件均无 embedding、均非 tombstone（纯硬去重态）。
      const { rows } = await pool!.query<{ merged_into: string | null }>(
        `SELECT merged_into FROM ai_news_events`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.merged_into === null)).toBe(true);
      // 其余阶段照常：两条独立事件都进 Top N、正常推送。
      expect(result.topNCount).toBe(2);
      expect(result.outcome).toBe('pushed');
      expect(sender.calls).toBe(1);
    } finally {
      env.SEMANTIC_DEDUP_ENABLED = saved;
    }
  });

  it('6.1 语义降级（embedding 抛错）不抛断、不进 judge/digest 熔断分母、不影响 outcome', async () => {
    const items = [
      item({ id: 'deg-a', url: 'https://ex.com/deg-a', title: 'News alpha' }),
      item({ id: 'deg-b', url: 'https://ex.com/deg-b', title: 'News beta' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      // embedding 恒抛错 → bootstrap 整批 failed、无合并；语义阶段不向上抛、不中止流水线。
      semantic: { embedding: { embed: { embedManyFn: embedManyFail(), maxAttempts: 1 }, logError: () => {} } },
      kb: { agent: { generateObjectFn: kbAgentMock(), maxAttempts: 1 }, embed: { embedManyFn: embedManySame(), maxAttempts: 1 } },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // 语义阶段跑了但全降级（embedding 失败 → 无合并），不抛断。
    expect(result.semantic).toBeDefined();
    expect(result.semantic!.highAutoMerged).toBe(0);
    expect(result.semantic!.llmConfirmedMerged).toBe(0);
    expect(result.semantic!.embedding.failed).toBeGreaterThan(0);
    // 熔断分母只含 judge/digest，语义降级不计入：judge 全过、digest 全过。
    expect(result.judge).toEqual({ processed: 2, degraded: 0 });
    expect(result.digest.degraded).toBe(0);
    // 不影响 outcome：两条独立事件照常推送。
    expect(result.outcome).toBe('pushed');
    expect(result.topNCount).toBe(2);
    expect(sender.calls).toBe(1);
  });

  it('6.2 KB 入库在 push 之后运行：高价值已推送事件写入 kb_documents', async () => {
    const items = [
      item({ id: 'kb-a', url: 'https://ex.com/kb-a', title: 'High value AI news' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      semantic: { embedding: { embed: { embedManyFn: embedManySame(), maxAttempts: 1 } } },
      // KB Agent 产 long_term_value=90 (>=70) → 入库；embedding 桩供 kb_documents 向量。
      kb: { agent: { generateObjectFn: kbAgentMock({ value: 90 }), maxAttempts: 1 }, embed: { embedManyFn: embedManySame(), maxAttempts: 1 } },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    expect(result.outcome).toBe('pushed');
    expect(result.kb).toBeDefined();
    expect(result.kb!.candidates).toBe(1); // 当日唯一 push success 事件。
    expect(result.kb!.ingested).toBe(1);

    // kb_documents 落一行，target_id = 被推送事件、kb_provider='custom'。
    const { rows: docs } = await pool!.query<{ target_id: string; long_term_value: number }>(
      `SELECT target_id, long_term_value FROM kb_documents`,
    );
    expect(docs).toHaveLength(1);
    expect(Number(docs[0]!.long_term_value)).toBe(90);
    const { rows: recs } = await pool!.query<{ status: string; kb_provider: string }>(
      `SELECT status, kb_provider FROM kb_ingestion_records`,
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe('success');
    expect(recs[0]!.kb_provider).toBe('custom');
  });

  it('6.2 低价值（long_term_value<70）被准入闸拦下、不写 kb_documents', async () => {
    const items = [
      item({ id: 'kb-low', url: 'https://ex.com/kb-low', title: 'Low value news' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      semantic: { embedding: { embed: { embedManyFn: embedManySame(), maxAttempts: 1 } } },
      kb: { agent: { generateObjectFn: kbAgentMock({ value: 62 }), maxAttempts: 1 }, embed: { embedManyFn: embedManySame(), maxAttempts: 1 } },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    expect(result.outcome).toBe('pushed');
    expect(result.kb!.candidates).toBe(1);
    expect(result.kb!.gatedOut).toBe(1);
    expect(result.kb!.ingested).toBe(0);
    const { rows } = await pool!.query<{ n: string }>(`SELECT count(*) AS n FROM kb_documents`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('6.2 KB 阶段异常不影响已成功的 push outcome（防御性兜底）', async () => {
    // KB Agent 注入恒抛错的 generateObjectFn → runKbIngestion 内部逐条 agentFailed 隔离；
    // 即便内部未隔离的异常，run-daily 外层 try/catch 也兜住，不影响已 pushed 的 outcome。
    const items = [
      item({ id: 'kb-err', url: 'https://ex.com/kb-err', title: 'KB error path news' }),
    ];
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning(items) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      semantic: { embedding: { embed: { embedManyFn: embedManySame(), maxAttempts: 1 } } },
      kb: {
        agent: {
          generateObjectFn: async () => {
            throw new Error('kb agent boom');
          },
          maxAttempts: 1,
          logError: () => {},
        },
      },
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // push 已成功：outcome 不被 KB 失败污染。
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
    // KB 阶段跑了但无入库（Agent 全失败）。
    expect(result.kb).toBeDefined();
    expect(result.kb!.ingested).toBe(0);
    const { rows } = await pool!.query<{ n: string }>(`SELECT count(*) AS n FROM kb_documents`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

/**
 * runDailyWorkflow 要闻段↔新品段跨段去重抑制集成测试
 * （add-cross-segment-dedup-and-hn-purify 组 C，tasks 2.4/2.5，design D3/D4）。
 *
 * 验证编排接线（纯函数键比对已在 src/selection/__tests__/cross-segment-dedup.test.ts 单测）：
 * - 2.4 幂等 + 唯一约束：事件 canonical_url 域 = 某产品 canonical_domain → 要闻段剔该事件、
 *   该 event 无 push_records 行（不写 event 命名空间）、新品段含该产品按 target_type='product' 正常写。
 * - 2.5 跨天候选资格 / 早退 / Model B：① 被剔事件次日产品不再候选时回要闻段推送、表头 X 取抑制后数；
 *   ② 全要闻段被抑制 + 新品非空 → 不早退、只推新品段；③ 产品仅 telegram 候选时抑制对两通道一致（并集）。
 *
 * 真实 selectProductsForChannelSafe（不 spy）→ 候选携带存储三键 productMergeKeys，供编排层构产品键集。
 * collapseProductsOnce spy 为 no-op（不触真实产品塌缩、不干扰 seed 的 ai_products）。
 * ai_products / 其 push_records 不在 cleanup 的 TRUNCATE 内，故 seed 用唯一前缀、本块 finally 显式清理。
 * 推送均注入 mock sender + 钉 channels（防误发生产飞书，memory test-no-prod-sends）。
 */
describe.skipIf(!canRun)('runDailyWorkflow 跨段去重抑制（组 C，2.4/2.5）', () => {
  const PROD_PREFIX = `rdw-xseg-${process.pid}-`;

  /** seed 一条 ai_products（直插，绕过塌缩）；canonical_domain/github_repo 任填。 */
  async function seedProduct(args: {
    suffix: string;
    canonicalDomain?: string | null;
    githubRepo?: string | null;
  }): Promise<string> {
    const productId = `${PROD_PREFIX}${args.suffix}`;
    await pool!.query(
      `INSERT INTO ai_products (product_id, name, canonical_domain, github_repo, last_seen_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        productId,
        `${PROD_PREFIX}${args.suffix}-name`,
        args.canonicalDomain ?? null,
        args.githubRepo ?? null,
      ],
    );
    return productId;
  }

  async function cleanupProducts() {
    if (!pool) return;
    await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${PROD_PREFIX}%`]);
    await pool.query(`DELETE FROM ai_products WHERE product_id LIKE $1`, [`${PROD_PREFIX}%`]);
  }

  it('2.4 同域同项目同进要闻与新品 → 要闻段剔除、event 无 push_record、产品照常写 product 行', async () => {
    await cleanupProducts();
    // 产品 canonical_domain 与事件 canonical_url 域一致（grassdx 类同域双段重复）。
    const domain = `grassdx-${process.pid}.example.com`;
    const pid = await seedProduct({ suffix: 'same-domain', canonicalDomain: domain });
    // 塌缩 no-op（不干扰 seed 的产品）；候选走真实路径（携带 productMergeKeys）。
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    try {
      // 事件 URL 域 = 产品域 → 跨段抑制命中。另造一条无关事件验证不被误剔。
      const items = [
        item({ id: 'xseg-hit', url: `https://${domain}/show`, title: 'Vet AI lawn (Show HN ish)' }),
        item({ id: 'xseg-keep', url: 'https://unrelated-news.example.com/x', title: 'Unrelated real news' }),
      ];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('pushed');
      expect(sender.calls).toBe(1);

      // 被抑制事件的 event_id：经 canonical_url 域命中 → 不应有 event push_record。
      // 先取两事件 event_id（按 representative_title 标记区分）。
      const evRows = await pool!.query<{ event_id: string; title: string }>(
        `SELECT event_id, representative_title AS title FROM ai_news_events`,
      );
      const hitEvent = evRows.rows.find((r) => r.title.includes('Vet AI lawn'))!;
      const keepEvent = evRows.rows.find((r) => r.title.includes('Unrelated real news'))!;
      expect(hitEvent).toBeTruthy();
      expect(keepEvent).toBeTruthy();

      // 被剔事件**无 event push_record**（不写 event 命名空间，保跨天候选资格）。
      const hitRecs = await pool!.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_records WHERE target_type='event' AND target_id=$1`,
        [hitEvent.event_id],
      );
      expect(Number(hitRecs.rows[0]!.n)).toBe(0);

      // 未被剔事件正常写 event success。
      const keepRecs = await pool!.query<{ status: string }>(
        `SELECT status FROM push_records WHERE target_type='event' AND target_id=$1`,
        [keepEvent.event_id],
      );
      expect(keepRecs.rows[0]?.status).toBe('success');

      // 产品按 target_type='product' 正常写 success（UNIQUE(target_type,target_id,channel,push_date) 不冲突）。
      const prodRecs = await pool!.query<{ status: string }>(
        `SELECT status FROM push_records WHERE target_type='product' AND target_id=$1`,
        [pid],
      );
      expect(prodRecs.rows[0]?.status).toBe('success');
    } finally {
      collapseSpy.mockRestore();
      await cleanupProducts();
    }
  });

  it('2.5① 被剔事件次日产品不再候选时回要闻段推送（无永久漏推）、表头取抑制后实发数', async () => {
    await cleanupProducts();
    const domain = `crossday-${process.pid}.example.com`;
    const pid = await seedProduct({ suffix: 'cross-day', canonicalDomain: domain });
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    const url = `https://${domain}/post`;
    try {
      // Day 1：事件与产品同域 → 事件被抑制、不写 event push_record；产品 success。
      const s1 = okSender();
      const r1 = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning([item({ id: 'cd1', url, title: 'Cross day suppressed' })]) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender: s1,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      // 唯一事件被抑制 + 产品非空 → 不早退、推一条（只新品段）；表头要闻数为 0（抑制后实发）。
      expect(r1.outcome).toBe('pushed');
      expect(s1.calls).toBe(1);
      const evRow = await pool!.query<{ event_id: string }>(`SELECT event_id FROM ai_news_events`);
      const eventId = evRow.rows[0]!.event_id;
      // 被剔事件无 event push_record（保跨天候选资格）。
      const d1EventRecs = await pool!.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_records WHERE target_type='event' AND target_id=$1`,
        [eventId],
      );
      expect(Number(d1EventRecs.rows[0]!.n)).toBe(0);
      // 产品 Day1 success。
      const d1ProdRecs = await pool!.query<{ status: string }>(
        `SELECT status FROM push_records WHERE target_type='product' AND target_id=$1`,
        [pid],
      );
      expect(d1ProdRecs.rows[0]?.status).toBe('success');

      // Day 2：产品已 success（一生一次）→ 不再是候选 → 产品键集空 → 事件不再被抑制 → 回要闻段推送。
      const NOW_DAY2 = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
      const s2 = okSender();
      const r2 = await runDailyWorkflow({
        now: NOW_DAY2,
        dbh: db!,
        // 同 URL 重新抓到（不同 source_item_id）→ 塌缩进既有事件（published_at 已非 NULL、仍在窗口）。
        collect: { collectors: collectorsReturning([item({ id: 'cd1b', url, title: 'Cross day recover' })]) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender: s2,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(r2.outcome).toBe('pushed');
      expect(s2.calls).toBe(1);
      // 事件 Day2 回要闻段、正常写 event success（无永久漏推）。
      const d2EventRecs = await pool!.query<{ status: string }>(
        `SELECT status FROM push_records WHERE target_type='event' AND target_id=$1`,
        [eventId],
      );
      expect(d2EventRecs.rows[0]?.status).toBe('success');
    } finally {
      collapseSpy.mockRestore();
      await cleanupProducts();
    }
  });

  it('2.5② 全要闻段被抑制 + 新品非空 → 按 pushableDeduped 不早退、只推新品段', async () => {
    await cleanupProducts();
    // 两个产品域，分别对齐两条（即全部）要闻事件 → pushableDeduped 为空、但产品候选非空。
    const dom1 = `allsup1-${process.pid}.example.com`;
    const dom2 = `allsup2-${process.pid}.example.com`;
    const pid1 = await seedProduct({ suffix: 'allsup-1', canonicalDomain: dom1 });
    const pid2 = await seedProduct({ suffix: 'allsup-2', canonicalDomain: dom2 });
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    try {
      const items = [
        item({ id: 'as1', url: `https://${dom1}/a`, title: 'All suppressed one' }),
        item({ id: 'as2', url: `https://${dom2}/b`, title: 'All suppressed two' }),
      ];
      const sender = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning(items) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        sender,
        channels: ['telegram'],
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      // 全要闻被抑制（pushableDeduped 空）但新品非空 → 不早退、推一条（只新品段）。
      expect(result.outcome).toBe('pushed');
      expect(sender.calls).toBe(1);
      // 无 event push_record（两条都被剔，皆不写 event 命名空间）。
      const evRecs = await pool!.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_records WHERE target_type='event'`,
      );
      expect(Number(evRecs.rows[0]!.n)).toBe(0);
      // 两产品均按 target_type='product' 正常写 success。
      const prodRecs = await pool!.query<{ target_id: string; status: string }>(
        `SELECT target_id, status FROM push_records WHERE target_type='product' AND target_id LIKE $1`,
        [`${PROD_PREFIX}%`],
      );
      expect(prodRecs.rows.find((r) => r.target_id === pid1)?.status).toBe('success');
      expect(prodRecs.rows.find((r) => r.target_id === pid2)?.status).toBe('success');
    } finally {
      collapseSpy.mockRestore();
      await cleanupProducts();
    }
  });

  it('2.5③ 产品仅 telegram 候选（feishu 已 success）→ 抑制用并集口径、对两通道一致', async () => {
    await cleanupProducts();
    const domain = `unionscope-${process.pid}.example.com`;
    const pid = await seedProduct({ suffix: 'union', canonicalDomain: domain });
    // 预置：该产品已在 **feishu** success（任一 push_date）→ feishu 候选排除它、仅 telegram 候选。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('product', $1, 'feishu', '2099-03-01', 'success', now())`,
      [pid],
    );
    const collapseSpy = vi
      .spyOn(productDigestModule, 'collapseProductsOnce')
      .mockResolvedValue(undefined);
    try {
      const url = `https://${domain}/x`;
      const tg = okSender();
      const fs = okSender();
      const result = await runDailyWorkflow({
        now: NOW,
        dbh: db!,
        collect: { collectors: collectorsReturning([item({ id: 'us1', url, title: 'Union scope event' })]) },
        judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
        digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
        channels: ['telegram', 'feishu'],
        senders: { telegram: tg, feishu: fs },
        lock: LOCK_OPTS,
        alert: vi.fn(),
      });
      expect(result.outcome).toBe('pushed');

      // 并集口径：产品在 telegram 候选（feishu 不在）→ channel-blind 要闻段对该事件抑制对两通道一致：
      // 该 event 在**两个通道**都不写 event push_record（不是只在 telegram 剔、feishu 留）。
      const evRows = await pool!.query<{ event_id: string }>(`SELECT event_id FROM ai_news_events`);
      const eventId = evRows.rows[0]!.event_id;
      const evRecs = await pool!.query<{ channel: string }>(
        `SELECT channel FROM push_records WHERE target_type='event' AND target_id=$1`,
        [eventId],
      );
      expect(evRecs.rows).toHaveLength(0); // 两通道皆无 event 行（并集抑制一致）。

      // 产品：telegram 候选 → telegram 写 product success；feishu 已 success（预置 2099-03-01），
      // 当日 feishu 不再候选 → 当日不再新增 feishu 产品行（沿用预置那条）。
      const prodTg = await pool!.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_records WHERE target_type='product' AND target_id=$1 AND channel='telegram' AND status='success'`,
        [pid],
      );
      expect(Number(prodTg.rows[0]!.n)).toBe(1);
    } finally {
      collapseSpy.mockRestore();
      await cleanupProducts();
    }
  });
});

/**
 * runDailyWorkflow 实践锦囊推送段集成测试（add-ai-blogger-experience-mining 组 E，tasks 5.3，design D6）。
 *
 * 验证编排接线（不重测组 D 内部，已各自单测/集成）：
 * - 同日同卡片同通道不重复推（UNIQUE(target_type,target_id,channel,push_date) 兜底）。
 * - 跨天不重推（selectExperiencesForChannel 的「从未以该 channel success」anti-join）。
 * - 上线不批量回推窗口外旧经验（published_at recency 窗口谓词只推当期）。
 * - channel-blind 只提炼一次（双通道断言注入的 mineExperienceFn 仅被调一次）。
 * - **纯经验日（无新闻无产品但有 ≥70 卡片）仍推经验、不被三元早退跳过**（design D6 命门）。
 * - 与 event/product/alert/weekly 的 target_type 不挤占（experience 独立幂等命名空间）。
 *
 * 注入 mock sender + 钉 channels（防误发生产飞书/Telegram，memory test-no-prod-sends）；注入
 * mock mineExperienceFn（不真调经验提炼 LLM）。ai_experiences / kb_* 不在顶部 cleanup 的 TRUNCATE 内，
 * 故本块 beforeEach/afterEach 额外清理（seed 用唯一前缀 + DELETE 兜底）。
 */
describe.skipIf(!canRun)('runDailyWorkflow 实践锦囊推送段（组 E，5.3）', () => {
  const EXP_PREFIX = `exp-${process.pid}-`;

  /** 窗口内 published_at（与 item() 同口径，落在候选窗口闭区间内）。 */
  const IN_WINDOW = '2000-01-01T00:00:00Z';
  /** 窗口外（远早于 NOW=2000-01-01 的下界）的旧 published_at —— 模拟「上线前的历史旧经验」。 */
  const OUT_OF_WINDOW = '1990-06-01T00:00:00Z';

  /**
   * 直接 seed 一条 ai_experiences 卡片（绕过提炼，专测推送段编排）。
   * canonical_source_url / id 用唯一前缀隔离；返回主键 id（= 推送 target_id）。
   */
  async function seedExperience(args: {
    suffix: string;
    longTermValue: number;
    publishedAt: string | null;
    headlineZh?: string;
    summaryZh?: string;
  }): Promise<string> {
    const url = `https://blogger.example.com/${EXP_PREFIX}${args.suffix}`;
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO ai_experiences
         (canonical_source_url, representative_raw_item_id, scenario, tools, techniques,
          applicability, long_term_value, headline_zh, summary_zh, published_at)
       VALUES ($1, 1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        url,
        `${EXP_PREFIX}场景`,
        JSON.stringify(['ToolA']),
        `${EXP_PREFIX}做法`,
        `${EXP_PREFIX}前提`,
        args.longTermValue,
        args.headlineZh ?? `${EXP_PREFIX}${args.suffix} 一句话要点`,
        args.summaryZh ?? `${EXP_PREFIX}${args.suffix} 中文摘要正文`,
        args.publishedAt,
      ],
    );
    return rows[0]!.id;
  }

  /** ExperienceCard 桩（注入 mineExperienceFn 用，避免真调 LLM）。 */
  function cardStub(longTermValue: number): import('../../agents/experience-mining/index.js').ExperienceCard {
    return {
      scenario: `${EXP_PREFIX}mined 场景`,
      tools: ['ToolMined'],
      techniques: `${EXP_PREFIX}mined 做法`,
      applicability: `${EXP_PREFIX}mined 前提`,
      long_term_value: longTermValue,
      headline_zh: `${EXP_PREFIX}mined 要点`,
      summary_zh: `${EXP_PREFIX}mined 摘要`,
    };
  }

  async function cleanupExperiences() {
    if (!pool) return;
    // push_records / kb_* 与 raw_items 中本块产物按前缀 / target_type 清理；ai_experiences 全清前缀行。
    await pool.query(`DELETE FROM push_records WHERE target_type='experience'`);
    await pool.query(`DELETE FROM kb_documents WHERE target_type='experience'`);
    await pool.query(`DELETE FROM kb_ingestion_records WHERE target_type='experience'`);
    await pool.query(`DELETE FROM ai_experiences WHERE canonical_source_url LIKE $1`, [
      `%${EXP_PREFIX}%`,
    ]);
  }

  beforeEach(cleanupExperiences);
  afterEach(cleanupExperiences);

  /** 共享注入：不真调经验提炼/KB（store 桩走真实 storeKbDocument，但卡片由 seed/桩控制）。 */
  const noMineExperience = {
    // 默认无 blogger raw_items → 选条空 → 不会调到；显式桩防回退真实 LLM。
    mineExperienceFn: async () => cardStub(90),
  };

  it('纯经验日（无新闻无产品但有 ≥70 卡片）仍推经验、不被三元早退跳过', async () => {
    // 新闻三源全空 + 无产品候选 + 一条窗口内 ≥70 经验卡片 → 三元早退不触发、推实践锦囊。
    const expId = await seedExperience({ suffix: 'pure', longTermValue: 88, publishedAt: IN_WINDOW });
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });

    // 新闻 Top N 空、产品空，但经验非空 → 不早退、推一条（仅实践锦囊段）。
    expect(result.topNCount).toBe(0);
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
    // experience push_record success（独立 target_type）。
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM push_records WHERE target_type='experience' AND target_id=$1`,
      [expId],
    );
    expect(rows[0]?.status).toBe('success');
  });

  it('同日同卡片同通道不重复推（UNIQUE 四元组兜底）', async () => {
    const expId = await seedExperience({ suffix: 'dup', longTermValue: 90, publishedAt: IN_WINDOW });
    // 第一次推：success。
    const s1 = okSender();
    const r1 = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender: s1,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(r1.outcome).toBe('pushed');
    expect(s1.calls).toBe(1);

    // 同日第二次跑（同卡片同通道）：已 success → 候选 anti-join 排除 → 待发空 → 不重推。
    const s2 = okSender();
    const r2 = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender: s2,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(s2.calls).toBe(0); // 不重发。
    expect(r2.outcome).toBe('skipped-no-candidates');
    // 仍只有一条 experience success（UNIQUE 四元组 + anti-join，无重复行）。
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM push_records WHERE target_type='experience' AND target_id=$1 AND status='success'`,
      [expId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('跨天不重推（次日同卡片已 success → 移出候选、不重推）', async () => {
    const expId = await seedExperience({ suffix: 'xday', longTermValue: 91, publishedAt: IN_WINDOW });
    // Day 1：推 success。
    const s1 = okSender();
    await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender: s1,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(s1.calls).toBe(1);

    // Day 2（+1 天，新 push_date）：卡片仍在窗口（published_at IN_WINDOW 距 NOW_DAY2 仍 <3 天），
    // 但已 success → 「从未以该 channel success」anti-join 排除 → 不重推。
    const NOW_DAY2 = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const s2 = okSender();
    const r2 = await runDailyWorkflow({
      now: NOW_DAY2,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender: s2,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(s2.calls).toBe(0); // 跨天不重推。
    expect(r2.outcome).toBe('skipped-no-candidates');
    // UNIQUE 四元组：仍只有 Day 1 一条 experience success（Day 2 未新增）。
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM push_records WHERE target_type='experience' AND target_id=$1 AND status='success'`,
      [expId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('上线不批量回推窗口外旧经验（published_at 窗口谓词只推当期）', async () => {
    // 一条窗口外旧卡片（1990）+ 一条窗口内当期卡片（2000）：首跑只推当期，窗口外永不回推。
    const oldId = await seedExperience({ suffix: 'old', longTermValue: 95, publishedAt: OUT_OF_WINDOW });
    const freshId = await seedExperience({ suffix: 'fresh', longTermValue: 80, publishedAt: IN_WINDOW });
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);

    // 当期卡片有 experience success；窗口外旧卡片**无任何 push_record**（被 recency 窗口排除，不回推）。
    const freshRecs = await pool!.query<{ status: string }>(
      `SELECT status FROM push_records WHERE target_type='experience' AND target_id=$1`,
      [freshId],
    );
    expect(freshRecs.rows[0]?.status).toBe('success');
    const oldRecs = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM push_records WHERE target_type='experience' AND target_id=$1`,
      [oldId],
    );
    expect(Number(oldRecs.rows[0]!.n)).toBe(0); // 窗口外旧经验绝不批量回推。
  });

  it('channel-blind 只提炼一次（双通道下注入的 mineExperienceFn 仅被调一次）', async () => {
    // seed 一条 blogger raw_item（source='blogger'/raw_type='experience'/collapsed=true/canonical_url 非空），
    // 走真实 runExperienceMiningOnce 选条 + 注入 mineExperienceFn 桩（计数）→ 写 ai_experiences。
    // 双通道 → 提炼 channel-blind 只跑一次（mine 调用次数 = 1），候选 per-channel 各展开一次。
    const canonicalUrl = `https://blogger.example.com/${EXP_PREFIX}mineonce`;
    await pool!.query(
      `INSERT INTO raw_items
         (source, source_item_id, raw_type, url, canonical_url, title, content, published_at, collapsed)
       VALUES ('blogger', $1, 'experience', $2, $2, $3, $4, $5, true)`,
      [
        `${EXP_PREFIX}mineonce`,
        canonicalUrl,
        `${EXP_PREFIX} blogger 经验标题`,
        `${EXP_PREFIX} 经验正文`,
        IN_WINDOW,
      ],
    );
    const mineSpy = vi.fn(async () => cardStub(90));
    const tg = okSender();
    const fs = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: { mineExperienceFn: mineSpy },
      channels: ['telegram', 'feishu'],
      senders: { telegram: tg, feishu: fs },
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(result.outcome).toBe('pushed');
    // **提炼 channel-blind 只跑一次**：mineExperienceFn 仅被调一次（不随 2 个 channel 重复）。
    expect(mineSpy).toHaveBeenCalledTimes(1);
    expect(result.experienceMining?.mined).toBe(1);
    // 卡片落 ai_experiences 一行。
    const { rows: expRows } = await pool!.query<{ id: string }>(
      `SELECT id FROM ai_experiences WHERE canonical_source_url=$1`,
      [canonicalUrl],
    );
    expect(expRows).toHaveLength(1);
    const expId = expRows[0]!.id;
    // 两通道各发一条消息，各推一条实践锦囊（experience push_record 各 channel 一行 success）。
    expect(tg.calls).toBe(1);
    expect(fs.calls).toBe(1);
    const { rows: prRows } = await pool!.query<{ channel: string; status: string }>(
      `SELECT channel, status FROM push_records WHERE target_type='experience' AND target_id=$1 ORDER BY channel`,
      [expId],
    );
    expect(prRows.map((r) => r.channel)).toEqual(['feishu', 'telegram']);
    for (const r of prRows) expect(r.status).toBe('success');
  });

  it('与 event/product/alert/weekly 的 target_type 不挤占（experience 独立幂等命名空间）', async () => {
    // 预置一条 event + 一条 alert + 一条 weekly 的 success 记录（同一个 target_id 字面值），
    // 再推一条 experience（同 target_id 字面值）→ experience 写 success、不与其它 target_type 冲突/挤占。
    const sharedId = await seedExperience({ suffix: 'noclash', longTermValue: 90, publishedAt: IN_WINDOW });
    const pushDate = (await import('../../push/push-date.js')).getPushDate(NOW);
    // 预置其它 target_type 的同 target_id 行（不同命名空间，不应被 experience 挤占）。
    for (const tt of ['event', 'product', 'alert', 'weekly']) {
      await pool!.query(
        `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
         VALUES ($1, $2, 'telegram', $3, 'success', now())`,
        [tt, sharedId, pushDate],
      );
    }
    const sender = okSender();
    const result = await runDailyWorkflow({
      now: NOW,
      dbh: db!,
      collect: { collectors: collectorsReturning([]) },
      judge: { judge: { generateObjectFn: judgeMock(), maxAttempts: 1 } },
      digest: { generateObjectFn: digestMock(), maxAttempts: 1 },
      experienceMining: noMineExperience,
      sender,
      channels: ['telegram'],
      lock: LOCK_OPTS,
      alert: vi.fn(),
    });
    expect(result.outcome).toBe('pushed');
    expect(sender.calls).toBe(1);
    // experience 写 success（独立命名空间，不被 event/product/alert/weekly 同 target_id 挤占）。
    const { rows } = await pool!.query<{ target_type: string; status: string }>(
      `SELECT target_type, status FROM push_records WHERE target_id=$1 AND channel='telegram' ORDER BY target_type`,
      [sharedId],
    );
    const byType = Object.fromEntries(rows.map((r) => [r.target_type, r.status]));
    // 五个 target_type 各一行 success，互不挤占。
    expect(byType.experience).toBe('success');
    expect(byType.event).toBe('success');
    expect(byType.product).toBe('success');
    expect(byType.alert).toBe('success');
    expect(byType.weekly).toBe('success');
    // 预置的 event/product/alert/weekly 各仍只一行（experience 推送未触碰它们）。
    for (const tt of ['event', 'product', 'alert', 'weekly', 'experience']) {
      const c = await pool!.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_records WHERE target_type=$1 AND target_id=$2`,
        [tt, sharedId],
      );
      expect(Number(c.rows[0]!.n)).toBe(1);
    }
  });
});
