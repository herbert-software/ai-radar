/**
 * Top N 候选窗口集成测试（任务 8.3 的 DB 侧断言）——需本地 Postgres。
 *
 * 单测（top-n.test.ts）已覆盖确定性排序/权重；本套件验证只有 DB 才能验的候选窗口条件：
 * - importance 低于下限闸的事件被过滤（即便 should_push=true）。
 * - 已被任一 push_date 以 telegram success 推送过的事件不再入选（跨天不重推）。
 * - 候选多于 N 时确定性取前 N（对同一批已落库事件多次运行结果一致）。
 * - should_push=false / 不在近 N 天窗口的事件不入候选。
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
      args.publishedAt ?? null,
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

  it('should_push=false 与不在近 N 天窗口的事件不入候选', async () => {
    const notPush = await seedEvent({
      key: 'notpush',
      importance: 90,
      shouldPush: false,
    });
    const stale = await seedEvent({
      key: 'stale',
      importance: 90,
      firstSeenAt: new Date('2099-01-01T00:00:00Z'), // 远早于近 3 天。
    });
    const ok = await seedEvent({ key: 'inwindow', importance: 90 });

    const top = await selectTopN({ now: NOW, importanceFloor: 60, windowDays: 3 }, db!);
    const ids = top.map((e) => e.eventId);
    expect(ids).toContain(ok);
    expect(ids).not.toContain(notPush);
    expect(ids).not.toContain(stale);
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
