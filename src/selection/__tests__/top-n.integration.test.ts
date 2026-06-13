/**
 * Top N 候选窗口集成测试（任务 8.3 的 DB 侧断言）——需本地 Postgres。
 *
 * 单测（top-n.test.ts）已覆盖确定性排序/权重；本套件验证只有 DB 才能验的候选窗口条件：
 * - importance 低于下限闸的事件被过滤（即便 should_push=true）。
 * - 已被任一 push_date 以 telegram success 推送过的事件不再入选（跨天不重推）。
 * - 候选多于 N 时确定性取前 N（对同一批已落库事件多次运行结果一致）。
 * - should_push=false 的事件不入候选。
 * - 时效闸键于 published_at（闭区间 lowerBound <= published_at <= now）：
 *   · published_at 旧的高分老文（first_seen_at=今天）不入候选（证明改用 published_at）；
 *   · published_at 在窗口内的入候选；
 *   · published_at 为 NULL 的不入候选（gte/lte 对 NULL 返假 → NULL 即排除）；
 *   · published_at 为未来日期（含来自确定性来源 RSS/GitHub）的不入候选（上界排除）。
 *
 * 缺 DATABASE_URL 时自动跳过。用唯一 dedup_key 前缀隔离造的 event 行，afterAll 清理。
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

const { selectTopN } = await import('../top-n.js');
// 与 selectTopN 内部时效窗口下界共用的唯一时间源（push-date.ts，Asia/Shanghai）——
// 6.3 边界用例用它算下界、断言窗口「今天」与 push_date 同源（无第二套时区计算）。
const { startOfDayInTimeZone } = await import('../../push/push-date.js');

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const PREFIX = 'topn-itest-';
const NOW = new Date('2099-02-01T04:00:00Z');

/** 直接插一条已评分 event 行（绕过塌缩/judge，专测选择逻辑），返回 event_id。 */
async function seedEvent(args: {
  key: string;
  importance: number;
  novelty?: number;
  developerRelevance?: number;
  hypeRisk?: number;
  shouldPush?: boolean;
  firstSeenAt?: Date;
  publishedAt?: Date | null;
}): Promise<string> {
  const { rows } = await pool!.query<{ event_id: string }>(
    `INSERT INTO ai_news_events
       (dedup_key, representative_title, summary_zh, should_push,
        importance_score, novelty_score, developer_relevance_score, hype_risk_score,
        first_seen_at, published_at, source_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
     RETURNING event_id`,
    [
      `${PREFIX}${args.key}`,
      `title-${args.key}`,
      `summary-${args.key}`,
      args.shouldPush ?? true,
      args.importance,
      args.novelty ?? 50,
      args.developerRelevance ?? 50,
      args.hypeRisk ?? 0,
      args.firstSeenAt ?? new Date('2099-02-01T00:00:00Z'),
      // 时效闸已键于 published_at：默认给一个在窗口内（< NOW）的发布时间，使非时效用例
      // 不被时效闸误过滤；要测「NULL 即排除」的用例显式传 publishedAt: null。
      args.publishedAt === undefined
        ? new Date('2099-02-01T00:00:00Z')
        : args.publishedAt,
    ],
  );
  return rows[0]!.event_id;
}

async function markPushedSuccess(
  eventId: string,
  pushDate: string,
  channel = 'telegram',
) {
  await pool!.query(
    `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
     VALUES ('event', $1, $2, $3, 'success', now())`,
    [eventId, channel, pushDate],
  );
}

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM push_records WHERE target_id IN
       (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [
    `${PREFIX}%`,
  ]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!databaseUrl)('Top N 候选窗口（DB 侧不变量）', () => {
  it('importance 低于下限闸（60）的事件被过滤，即便 should_push=true', async () => {
    const high = await seedEvent({ key: 'floor-high', importance: 85 });
    const low = await seedEvent({ key: 'floor-low', importance: 40 });

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(high);
    expect(ids).not.toContain(low);
  });

  it('已被任一 push_date 以 telegram success 推送过的事件不再入选（跨天不重推）', async () => {
    const fresh = await seedEvent({ key: 'never', importance: 90 });
    const pushed = await seedEvent({ key: 'pushed', importance: 95 });
    // 在「昨天」成功推送过 pushed（不同 push_date 也算 success 过）。
    await markPushedSuccess(pushed, '2099-01-31');

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(pushed);
  });

  it('Model B + 各通道可靠补发：候选 = 「尚未投递给所有已配置通道」，缺任一通道仍入选', async () => {
    // 统一日报模型：选一份 channel-blind Top N；候选窗口排除「已投递给**所有**已配置通道」者，
    // 只要还差任一通道未 success 就留在名单（由 dispatcher per-channel 跨天补发该通道）。
    const onlyFeishu = await seedEvent({ key: 'only-feishu', importance: 95 });
    const onlyTelegram = await seedEvent({ key: 'only-tg', importance: 94 });
    const fresh = await seedEvent({ key: 'fresh', importance: 90 });
    await markPushedSuccess(onlyFeishu, '2099-01-31', 'feishu');
    await markPushedSuccess(onlyTelegram, '2099-01-31', 'telegram');

    // 默认已配置通道 = [telegram]：仅当 telegram 已 success 才算「投递给所有通道」→ 排除。
    const tgOnly = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const tgIds = tgOnly.map((e) => e.eventId);
    expect(tgIds).not.toContain(onlyTelegram); // telegram 已投递 → 移出
    expect(tgIds).toContain(onlyFeishu); // telegram 仍缺（只 feishu 推过）→ 仍入选，待 telegram 补发
    expect(tgIds).toContain(fresh);

    // 已配置 [telegram, feishu]：success 须覆盖两通道才算「全部投递」→ 单通道 success 仍入选。
    const both = await selectTopN(
      { now: NOW, importanceFloor: 60, windowDays: 3, channels: ['telegram', 'feishu'] },
      db!,
    );
    const bothIds = both.map((e) => e.eventId);
    expect(bothIds).toContain(onlyFeishu); // telegram 缺 → 仍入选
    expect(bothIds).toContain(onlyTelegram); // feishu 缺 → 仍入选
    expect(bothIds).toContain(fresh);
  });

  it('Model B：已投递给所有已配置通道的事件移出统一名单（不再跨天重选）', async () => {
    const delivered = await seedEvent({ key: 'all-done', importance: 95 });
    const fresh = await seedEvent({ key: 'fresh2', importance: 90 });
    // 两通道都 alert... 这里是 event：两通道都 success → 视为全部投递。
    await markPushedSuccess(delivered, '2099-01-31', 'telegram');
    await markPushedSuccess(delivered, '2099-01-31', 'feishu');

    const top = await selectTopN(
      { now: NOW, importanceFloor: 60, windowDays: 3, channels: ['telegram', 'feishu'] },
      db!,
    );
    const ids = top.map((e) => e.eventId);
    expect(ids).not.toContain(delivered); // 两通道都投递完毕 → 移出
    expect(ids).toContain(fresh);
  });

  it('should_push=false 的事件不入候选', async () => {
    const notPush = await seedEvent({
      key: 'notpush',
      importance: 90,
      shouldPush: false,
    });
    const ok = await seedEvent({ key: 'inwindow', importance: 90 });

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(ok);
    expect(ids).not.toContain(notPush);
  });

  it('时效闸键于 published_at（非 first_seen_at）：旧 published_at 的高分老文不入候选', async () => {
    // 关键回归：模拟「新增源/冷启动」——历史老文 published_at 多年前，但今日才首次抓到
    // （first_seen_at = 今天，落在窗口内）。改用 published_at 后该老文必被时效闸排除，
    // 不再被误当近 N 天新消息推送（2026-06-13 刷屏 bug 的根因用例）。
    const staleOldArticle = await seedEvent({
      key: 'stale-pub',
      importance: 95,
      firstSeenAt: new Date('2099-02-01T00:00:00Z'), // 今天才首见。
      publishedAt: new Date('2090-01-01T00:00:00Z'), // 发布于多年前，远早于近 3 天窗口。
    });
    const fresh = await seedEvent({
      key: 'fresh-pub',
      importance: 90,
      publishedAt: new Date('2099-02-01T00:00:00Z'), // 窗口内。
    });

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(fresh); // published_at 在窗口内 → 入候选。
    expect(ids).not.toContain(staleOldArticle); // first_seen=今天但 published_at 太旧 → 出窗。
  });

  it('published_at 为 NULL 的事件不入候选（gte/lte 对 NULL 返假 → NULL 即排除）', async () => {
    const nullPub = await seedEvent({
      key: 'null-pub',
      importance: 95,
      publishedAt: null, // AI 推断后仍判不出 → 保持 NULL。
    });
    const ok = await seedEvent({ key: 'null-ok', importance: 90 });

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(ok);
    expect(ids).not.toContain(nullPub); // NULL published_at 被自然排除。
  });

  it('published_at 为未来日期的事件不入候选（上界 published_at <= now 排除）', async () => {
    // 未来日期可来自确定性来源（RSS pubDate / GitHub pushed_at 源端 bug、时区错配、恶意 feed），
    // 经采集直接入库不过 AI 拦截；gte(published_at, lowerBound) 对未来恒真，必须靠上界 lte 兜底。
    const futurePub = await seedEvent({
      key: 'future-pub',
      importance: 95,
      publishedAt: new Date('2099-02-05T00:00:00Z'), // 晚于 NOW（2099-02-01）。
    });
    const ok = await seedEvent({ key: 'future-ok', importance: 90 });

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(ok);
    expect(ids).not.toContain(futurePub); // 未来日期被上界排除。
  });

  it('时区下界边界（任务 6.3①）：上海窗口下界 00:00 前 1 秒出窗、后 1 秒入窗', async () => {
    // 下界由 startOfDayInTimeZone(NOW, windowDays-1) 算出（与 push_date 同源 Asia/Shanghai）。
    // 闭区间 lowerBound <= published_at；published_at 是绝对时刻（timestamptz）的两个 UTC 时刻比较。
    // 构造「下界前 1 秒」与「下界后 1 秒」两条事件，断言前者出窗、后者入窗——固化日界 UTC 前后一瞬
    // 行为唯一确定（design D1「时区比较口径」/ spec「时区比较口径必须显式且唯一」）。
    const windowDays = 3;
    const lowerBound = startOfDayInTimeZone(NOW, windowDays - 1); // 与 selectTopN 内部同一函数。
    const justBefore = await seedEvent({
      key: 'lb-before',
      importance: 95,
      publishedAt: new Date(lowerBound.getTime() - 1000), // 下界前 1 秒 → 出窗。
    });
    const justAfter = await seedEvent({
      key: 'lb-after',
      importance: 90,
      publishedAt: new Date(lowerBound.getTime() + 1000), // 下界后 1 秒 → 入窗。
    });

    // topN: 100 避免 TOP_N 默认上限（本套件无 afterEach、跨 it 累积事件可能挤掉本用例的入窗事件）——
    // 本用例只验「下界 ±1 秒入/出窗」，topN 充足时入窗事件必出现在结果里、不被名额上限混淆。
    const top = await selectTopN({ now: NOW, topN: 100, importanceFloor: 60, windowDays }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).not.toContain(justBefore); // < lowerBound → 出窗（闭区间下界严格之外）。
    expect(ids).toContain(justAfter); // >= lowerBound → 入窗。
  });

  it('上界边界（任务 6.3②）：published_at = now 入窗（含等于）、now + 1ms 出窗（未来排除）', async () => {
    // 上界 lte(published_at, now) 含等于：now 当刻入窗、now+1ms 严格未来出窗（与上下界共用同一 now）。
    const atNow = await seedEvent({
      key: 'ub-eq-now',
      importance: 95,
      publishedAt: new Date(NOW.getTime()),
    });
    const justFuture = await seedEvent({
      key: 'ub-future-1ms',
      importance: 90,
      publishedAt: new Date(NOW.getTime() + 1),
    });

    // topN: 100 同上：避免名额上限挤掉入窗事件，隔离「上界 ±1ms 入/出窗」为唯一被测变量。
    const top = await selectTopN({ now: NOW, topN: 100, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(atNow); // <= now 含等于 → 入窗。
    expect(ids).not.toContain(justFuture); // now+1ms 未来 → 出窗。
  });

  it('候选多于 N 时确定性取前 N，且多次运行结果一致', async () => {
    // 造 5 条不同分数的候选，N=3。
    const keys = ['r1', 'r2', 'r3', 'r4', 'r5'];
    for (let i = 0; i < keys.length; i += 1) {
      await seedEvent({ key: keys[i]!, importance: 60 + i * 5 });
    }
    const run1 = (await selectTopN({ now: NOW, topN: 3, importanceFloor: 60, windowDays: 3 }, db!)).map(
      (e) => e.eventId,
    );
    const run2 = (await selectTopN({ now: NOW, topN: 3, importanceFloor: 60, windowDays: 3 }, db!)).map(
      (e) => e.eventId,
    );
    expect(run1).toEqual(run2);
    expect(run1).toHaveLength(3);
  });
});
