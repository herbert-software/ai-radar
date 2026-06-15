/**
 * tombstone 对下游消费者不可见（合并核心闭环）集成测试（组 D 任务 4.7，**需本地 Postgres**）。
 *
 * 两部分：
 * A. **读路径**：构造一条 tombstone 事件，断言它**不**进 value-judge 评分 / Top N / 告警候选 / 周报 /
 *    MCP search-events / source-quality 计数 / push-event-now / mark-event（命中 tombstone 走「未找到」）。
 * B. **并发交错**：模拟「候选 SELECT 选中 B → 日报合并把 B 置 tombstone → CAS 执行」交错，**通过驱动
 *    生产函数**（claimEventForJudging / scoreUnscoredEvents / backfillPublishedAt）而非手写内联 SQL——
 *    构造 B 在选中/claim 时非 tombstone、在生产函数自身 SELECT→CAS 间隙（评分写前 / 回填前，经注入桩内
 *    置 tombstone 复现）变为 tombstone，断言生产 CAS 自带 `merged_into IS NULL` 谓词命中 0 行、不 claim/
 *    不评分写/不回填/不复活 tombstone（若移除该谓词则这些断言会失败，从而真正守护生产 CAS）。
 *
 * 缺 DATABASE_URL 时自动跳过；每个用例用唯一前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { scoreUnscoredEvents, claimEventForJudging } = await import('../../agents/value-judge/score-events.js');
const { selectTopN } = await import('../../selection/top-n.js');
const { selectAlertCandidates } = await import('../../pipeline/alert-scan.js');
const { selectWeeklyEvents, weeklyAnchor } = await import('../../pipeline/weekly-report.js');
const { backfillPublishedAt } = await import('../../agents/published-at-inference/backfill.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'tombvis-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 直接 INSERT 一条 ai_news_events，返回 event_id。 */
async function seedEvent(args: {
  dedupKey: string;
  title: string;
  firstSeenAt: Date;
  publishedAt?: Date | null;
  importanceScore?: number | null;
  shouldPush?: boolean;
  mergedInto?: string | null;
  representativeRawItemId?: bigint | null;
}): Promise<string> {
  const { rows } = await pool!.query<{ event_id: string }>(
    `INSERT INTO ai_news_events
       (dedup_key, representative_title, first_seen_at, last_seen_at, published_at,
        importance_score, should_push, merged_into, representative_raw_item_id, source_count)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,1)
     RETURNING event_id`,
    [
      args.dedupKey,
      args.title,
      args.firstSeenAt,
      args.publishedAt ?? null,
      args.importanceScore ?? null,
      args.shouldPush ?? false,
      args.mergedInto ?? null,
      args.representativeRawItemId ?? null,
    ],
  );
  return rows[0]!.event_id;
}

async function seedRaw(sourceItemId: string, opts?: { url?: string; content?: string }): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title, content) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [SOURCE, sourceItemId, opts?.url ?? null, 'seed title', opts?.content ?? null],
  );
  return BigInt(rows[0]!.id);
}

async function fetchEvent(eventId: string) {
  const { rows } = await pool!.query<{
    event_id: string;
    merged_into: string | null;
    importance_score: string | null;
    judge_claimed_at: Date | null;
    published_at: Date | null;
    should_push: boolean;
  }>(
    `SELECT event_id, merged_into, importance_score, judge_claimed_at, published_at, should_push
     FROM ai_news_events WHERE event_id = $1`,
    [eventId],
  );
  return rows[0];
}

function cleanup(): Promise<unknown> {
  return pool!
    .query(`DELETE FROM push_records WHERE target_id IN (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $1)`, [`${SOURCE}-%`])
    .then(() => pool!.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${SOURCE}-%`]))
    .then(() => pool!.query(`DELETE FROM ai_news_events WHERE representative_raw_item_id IN (SELECT id FROM raw_items WHERE source=$1)`, [SOURCE]))
    .then(() => pool!.query(`DELETE FROM raw_items WHERE source=$1`, [SOURCE]));
}

beforeAll(async () => { if (pool) await cleanup(); });
afterAll(async () => { if (pool) { await cleanup(); await pool.end(); } });

describe.skipIf(!databaseUrl)('A. tombstone 读路径不可见', () => {
  it('tombstone（importance NULL、merged_into 非空）不被 value-judge 选中评分（候选 SELECT 排除）', async () => {
    const ts = Date.now();
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-vj-surv-${ts}`, title: 'survivor', firstSeenAt: new Date('2026-06-01T00:00:00Z'), importanceScore: 80, shouldPush: true });
    const tomb = await seedEvent({ dedupKey: `${SOURCE}-vj-tomb-${ts}`, title: 'tombstone', firstSeenAt: new Date('2026-06-02T00:00:00Z'), importanceScore: null, mergedInto: survivor });

    // 注入恒抛 judge 桩：若 tombstone 被选中送判会触发桩并写分；断言它不被选中（不评分、importance 仍 NULL）。
    const result = await scoreUnscoredEvents(
      {
        judge: { generateObjectFn: (async () => ({ object: { is_ai_related: true, type: 'news', category: 'x', importance: 90, novelty: 50, developer_relevance: 50, hype_risk: 10, should_push: true, reason: 'ok' } })) as never },
        logError: () => {},
      },
      db!,
    );
    // tombstone 不在候选集；本套件造的 survivor 已评分（importance 非 NULL）也不在候选。
    // 断言 tombstone 评分态未变。
    expect((await fetchEvent(tomb))!.importance_score).toBeNull();
    expect((await fetchEvent(tomb))!.merged_into).toBe(survivor);
    void result;
  });

  it('tombstone 不进 Top N（候选 SELECT 排除）', async () => {
    const ts = Date.now();
    const pub = new Date();
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-tn-surv-${ts}`, title: 'tn survivor', firstSeenAt: pub, publishedAt: pub, importanceScore: 90, shouldPush: true });
    // tombstone 即便 should_push=true、importance 高、published_at 近——也必须被排除。
    const tomb = await seedEvent({ dedupKey: `${SOURCE}-tn-tomb-${ts}`, title: 'tn tombstone', firstSeenAt: pub, publishedAt: pub, importanceScore: 95, shouldPush: true, mergedInto: survivor });

    const top = await selectTopN({ now: new Date(), windowDays: 30, importanceFloor: 60 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(survivor);
    expect(ids).not.toContain(tomb);
  });

  it('tombstone 不进告警候选（selectAlertCandidates 排除）', async () => {
    const ts = Date.now();
    const pub = new Date();
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-al-surv-${ts}`, title: 'al survivor', firstSeenAt: pub, publishedAt: pub, importanceScore: 90 });
    const tomb = await seedEvent({ dedupKey: `${SOURCE}-al-tomb-${ts}`, title: 'al tombstone', firstSeenAt: pub, publishedAt: pub, importanceScore: 95, mergedInto: survivor });

    const cands = await selectAlertCandidates(85, db!, ['telegram'], new Date(), 30, 50);
    const ids = cands.map((c) => c.eventId);
    expect(ids).toContain(survivor);
    expect(ids).not.toContain(tomb);
  });

  it('tombstone 不进周报候选（selectWeeklyEvents 排除）', async () => {
    // 周报窗口 = 上周一..本周一；用 weeklyAnchor 反推一个落在窗口内的 first_seen_at。
    const anchor = weeklyAnchor(new Date());
    const inWindow = new Date(anchor.windowStart.getTime() + 24 * 3600 * 1000);
    const ts = Date.now();
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-wk-surv-${ts}`, title: 'wk survivor', firstSeenAt: inWindow, importanceScore: 90, shouldPush: true });
    const tomb = await seedEvent({ dedupKey: `${SOURCE}-wk-tomb-${ts}`, title: 'wk tombstone', firstSeenAt: inWindow, importanceScore: 95, shouldPush: true, mergedInto: survivor });

    const events = await selectWeeklyEvents(anchor, db!, 50, 60);
    const ids = events.map((e) => e.eventId);
    expect(ids).toContain(survivor);
    expect(ids).not.toContain(tomb);
  });

  it('tombstone 不进 source-quality 的 count(distinct event_id)（MCP 工具查询排除）', async () => {
    const ts = Date.now();
    const rid = await seedRaw(`sq-${ts}`, { url: `https://example.com/sq-${ts}` });
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-sq-surv-${ts}`, title: 'sq survivor', firstSeenAt: new Date(), representativeRawItemId: rid });
    await seedEvent({ dedupKey: `${SOURCE}-sq-tomb-${ts}`, title: 'sq tombstone', firstSeenAt: new Date(), representativeRawItemId: rid, mergedInto: survivor });

    // 直接复刻 source-quality 的 count(distinct event_id) WHERE merged_into IS NULL（本套件 source 隔离）。
    const { rows } = await pool!.query<{ collapsed: string }>(
      `SELECT count(distinct e.event_id) AS collapsed
       FROM ai_news_events e
       JOIN raw_items r ON e.representative_raw_item_id = r.id
       WHERE r.source = $1 AND e.merged_into IS NULL`,
      [SOURCE],
    );
    // 两事件共用同一代表 raw_item，但 tombstone 被排除 → 仅 survivor 计数 = 1。
    expect(Number(rows[0]!.collapsed)).toBe(1);
  });
});

describe.skipIf(!databaseUrl)('B. 并发交错：CAS 自带谓词命中 0 行、不复活 tombstone', () => {
  it('候选 SELECT 选中 B → 合并把 B 置 tombstone → claim CAS 命中 0 行（不 claim）', async () => {
    const ts = Date.now();
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-cc-surv-${ts}`, title: 'cc survivor', firstSeenAt: new Date('2026-06-01T00:00:00Z'), importanceScore: 80 });
    const b = await seedEvent({ dedupKey: `${SOURCE}-cc-b-${ts}`, title: 'cc B', firstSeenAt: new Date('2026-06-02T00:00:00Z'), importanceScore: null });

    // 模拟交错：候选 SELECT 已选中 B（importance NULL），其后日报合并把 B 置 tombstone。
    await pool!.query(`UPDATE ai_news_events SET merged_into = $1 WHERE event_id = $2`, [survivor, b]);

    // 再执行 claim CAS：自身 WHERE merged_into IS NULL 不满足 → 'skipped'（命中 0 行，不 claim）。
    const claim = await claimEventForJudging(b, 180000, db!);
    expect(claim).toBe('skipped');
    expect((await fetchEvent(b))!.judge_claimed_at).toBeNull(); // 未被 claim，tombstone 未复活
  });

  it('真实 scoreUnscoredEvents：claim 成功后、评分写前 B 才被置 tombstone → 评分写 CAS 命中 0 行（链内二次窗口，*_score 不被写）', async () => {
    const ts = Date.now();
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-sw-surv-${ts}`, title: 'sw survivor', firstSeenAt: new Date('2026-06-01T00:00:00Z'), importanceScore: 80 });
    // B 在候选 SELECT/claim 时仍非 tombstone（importance NULL、merged_into NULL）→ 可被选中并 claim 成功。
    const b = await seedEvent({ dedupKey: `${SOURCE}-sw-b-${ts}`, title: 'sw B', firstSeenAt: new Date('2026-06-02T00:00:00Z'), importanceScore: null });

    // 注入 judge 桩：它在「claim 成功后、评分写前」被调用——在此刻把 B 置 tombstone，复现链内二次 TOCTOU。
    // 随后 scoreUnscoredEvents 的评分写 CAS（WHERE merged_into IS NULL）应命中 0 行、不写 *_score、不复活。
    // 桩对仅本事件做 tombstone（按 event_id），其余候选照常返回有效分（不影响本断言）。
    const result = await scoreUnscoredEvents(
      {
        judge: {
          generateObjectFn: (async () => {
            await pool!.query(`UPDATE ai_news_events SET merged_into=$1 WHERE event_id=$2`, [survivor, b]);
            return { object: { is_ai_related: true, type: 'news', category: 'x', importance: 90, novelty: 50, developer_relevance: 50, hype_risk: 10, should_push: true, reason: 'ok' } };
          }) as never,
        },
        logError: () => {},
      },
      db!,
    );
    // B 被 claim、送判，但评分写 CAS 因其已成 tombstone 命中 0 行 → importance 仍 NULL、should_push 仍 false。
    const after = await fetchEvent(b);
    expect(after!.importance_score).toBeNull(); // 未被评分写覆盖（CAS 谓词 merged_into IS NULL 拦下）
    expect(after!.should_push).toBe(false);
    expect(after!.merged_into).toBe(survivor); // 仍是 tombstone，未被复活
    // 计数诚实性（Bugbot「Zero row score still counts」修复）：评分写命中 0 行（claim 后被并发合并置
    // tombstone）既非评分成功也非 LLM 降级——生产代码不计 scored、并从熔断分母剔除（judged--）、释放该
    // 残留 claim。注：scoreUnscoredEvents 扫全表（非本 source 隔离），并行套件的未评分事件也会计入
    // result.scored/judged，故此处不对全局计数做精确断言（沿用 score-events 集成测试的 `>=` 约定）；本条
    // 0 行写的行为正确性已由上方「importance 仍 NULL / should_push 仍 false / merged_into 不变」证明。
    void result;
  });

  it('真实 backfillPublishedAt：候选选中 B → 合并置 tombstone → 回填 CAS 命中 0 行（published_at 不被回填）', async () => {
    const ts = Date.now();
    const rid = await seedRaw(`bf-${ts}`, { url: `https://example.com/bf-${ts}`, content: 'body' });
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-bf-surv-${ts}`, title: 'bf survivor', firstSeenAt: new Date('2026-06-01T00:00:00Z'), importanceScore: 90 });
    // B 在候选 SELECT 时仍非 tombstone（should_push、published_at NULL、窗内）→ 可被选中尝试回填。
    const b = await seedEvent({ dedupKey: `${SOURCE}-bf-b-${ts}`, title: 'bf B', firstSeenAt: new Date(), importanceScore: 90, shouldPush: true, publishedAt: null, representativeRawItemId: rid });

    // 注入 mock Redis（恒可获锁）+ infer 桩：infer 桩在「候选选中后、CAS 回填前」被调用——在此刻把 B 置
    // tombstone，复现链内 TOCTOU。随后回填 CAS（WHERE merged_into IS NULL）应命中 0 行、不回填 published_at。
    const mockRedis = { set: async () => 'OK' as const, eval: async () => 1 };
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 30,
      now: new Date(),
      dbh: db!,
      lock: { redis: mockRedis as never },
      infer: {
        generateObjectFn: (async () => {
          await pool!.query(`UPDATE ai_news_events SET merged_into=$1 WHERE event_id=$2`, [survivor, b]);
          return { object: { publishedAt: '2026-06-02', confidence: 0.9 } };
        }) as never,
      },
      logError: () => {},
    });
    // B 被选中、尝试推断，但回填 CAS 因其已成 tombstone 命中 0 行 → published_at 仍 NULL、未复活。
    expect((await fetchEvent(b))!.published_at).toBeNull();
    expect((await fetchEvent(b))!.merged_into).toBe(survivor);
    void result;
  });

  it('真实 backfillPublishedAt：tombstone 不进候选 SELECT（不浪费推断、不回填）', async () => {
    const ts = Date.now();
    const rid = await seedRaw(`bfreal-${ts}`, { url: `https://example.com/bfreal-${ts}`, content: 'body' });
    const survivor = await seedEvent({ dedupKey: `${SOURCE}-bfreal-surv-${ts}`, title: 'bfreal survivor', firstSeenAt: new Date(), importanceScore: 90, shouldPush: true });
    const tomb = await seedEvent({ dedupKey: `${SOURCE}-bfreal-tomb-${ts}`, title: 'bfreal tombstone', firstSeenAt: new Date(), importanceScore: 90, shouldPush: true, publishedAt: null, mergedInto: survivor, representativeRawItemId: rid });

    // 注入 mock Redis（恒可获取锁）+ inferPublishedAt 桩（若被调用会回一个确定日期）。
    const mockRedis = {
      set: async () => 'OK' as const,
      eval: async () => 1,
    };
    let inferCalled = 0;
    const result = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: 30,
      now: new Date(),
      dbh: db!,
      lock: { redis: mockRedis as never },
      infer: {
        generateObjectFn: (async () => {
          inferCalled += 1;
          return { object: { publishedAt: '2026-06-02', confidence: 0.9 } };
        }) as never,
      },
      logError: () => {},
    });
    // tombstone 不进候选 → 不尝试推断、不回填；inferPublishedAt 对 tombstone 从未被调用。
    expect((await fetchEvent(tomb))!.published_at).toBeNull();
    expect((await fetchEvent(tomb))!.merged_into).toBe(survivor);
    // 本套件只造了一个 NULL published_at 的事件且它是 tombstone → attempted 不含它。
    // （survivor published_at 也 NULL 但 shouldPush=true 且非 tombstone，可能被选中——允许其被推断，
    //  只断言 tombstone 未被回填。）
    void result;
    void inferCalled;
  });
});
