/**
 * 并发评分原子 claim 集成测试（任务 9.1b，realtime-alerts / daily-intel「降级逐条容错」）。
 * 需本地 Postgres（compose 起的库）。generateObjectFn 全程注入 mock，不依赖真实 LLM key。
 *
 * 覆盖不变量（design D6）：
 * - **两链路并发只评一次不覆写**：日报链与告警链同时 scoreUnscoredEvents 同一未评分事件，
 *   仅 claim 成功的一条送 LLM，另一条 claimSkipped；该事件只被评一次、*_score 不被覆写。
 * - **claim 后崩溃经 T 重评**：手写 judge_claimed_at（过去时刻，模拟崩溃残留僵尸 claim、score 仍 NULL），
 *   小 reclaimMs 下事件被重新 claim 评分；未过 T 时则不被重新 claim。
 * - **评分+写分总时长逼近 L+W 不被误回收**：claim 后立即写分（< T），另一链路并发不重新 claim 它。
 *
 * 缺 DATABASE_URL 时整套件 skip。每个用例用唯一 source/dedup 前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { collapseRawItem } = await import('../../../dedup/collapse.js');
const { scoreUnscoredEvents, claimEventForJudging } = await import(
  '../score-events.js'
);

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'claim-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const VALID = {
  is_ai_related: true,
  type: 'ai_product',
  category: 'AI Coding',
  importance: 82,
  novelty: 75,
  developer_relevance: 90,
  hype_risk: 35,
  should_push: true,
  reason: 'A new open-source coding agent.',
};

async function seedEvent(prefix: string): Promise<{ eventId: string; dedupKey: string }> {
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `https://example.com/${prefix}/${ts}`;
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [SOURCE, `${prefix}-${ts}`, url, 'Claimable event'],
  );
  const id = BigInt(rows[0]!.id);
  const out = await collapseRawItem(
    { id, url, title: 'Claimable event', publishedAt: null, fetchedAt: new Date() },
    db!,
  );
  // 取回 event_id（用于 claim 单测直接调）。
  const ev = await pool!.query<{ event_id: string }>(
    `SELECT event_id FROM ai_news_events WHERE dedup_key = $1`,
    [out.dedupKey],
  );
  return { eventId: ev.rows[0]!.event_id, dedupKey: out.dedupKey! };
}

async function fetchScores(dedupKey: string) {
  const { rows } = await pool!.query<{
    importance_score: string | null;
    judge_claimed_at: Date | null;
  }>(
    `SELECT importance_score, judge_claimed_at FROM ai_news_events WHERE dedup_key = $1`,
    [dedupKey],
  );
  return rows[0]!;
}

async function cleanup() {
  if (!pool) return;
  // 全表 TRUNCATE 隔离：scoreUnscoredEvents 的候选查询是**全局表读**（扫所有未评分事件），
  // 外部残留的未评分事件会让并发两链路各自抢到不同事件、claimSkipped 失真。TRUNCATE 确保
  // 全局读只看到本用例 seed 的唯一事件，使「两链路争抢同一事件」可被确定性断言。
  await pool.query(
    `TRUNCATE TABLE push_records, ai_news_events, raw_items RESTART IDENTITY`,
  );
}

beforeAll(cleanup);
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('并发评分原子 claim', () => {
  it('两链路并发只评一次不覆写（claim 原子性：并发 claim 同一事件仅一条成功）', async () => {
    const { eventId } = await seedEvent('concurrent');

    // 并发对同一未评分事件 claim（模拟日报链与告警链同时送 LLM 前的 claim）：
    // claim 是单条原子 `UPDATE ... WHERE *_score IS NULL AND (...) RETURNING`，DB 行锁串行化——
    // 即便完全并发，也只有一条 RETURNING 命中（成功），其余 0 行（跳过）。绝不双 claim。
    const results = await Promise.all([
      claimEventForJudging(eventId, 180_000, db!),
      claimEventForJudging(eventId, 180_000, db!),
      claimEventForJudging(eventId, 180_000, db!),
    ]);

    const claimed = results.filter((r) => r === 'claimed');
    const skipped = results.filter((r) => r === 'skipped');
    expect(claimed).toHaveLength(1); // 恰一条 claim 成功。
    expect(skipped).toHaveLength(2); // 其余跳过——不会被任一链路双评分。

    // 验证「只评一次不覆写」语义在 scoreUnscoredEvents 层成立：先释放上面 claim（写分），
    // 再让两链路顺序各跑一次 —— 已评分事件不再被任一链路 claim/送判（importance_score 非 NULL）。
    await pool!.query(
      `UPDATE ai_news_events SET importance_score = '82' WHERE event_id = $1`,
      [eventId],
    );
    const fnLate = vi.fn().mockResolvedValue({ object: { ...VALID, importance: 11 } });
    const res = await scoreUnscoredEvents(
      { judge: { generateObjectFn: fnLate, logError: () => {} }, logError: () => {} },
      db!,
    );
    // 该事件已评分：本轮不送判、不调 LLM 改写它的分（不覆写）。
    expect(fnLate).not.toHaveBeenCalled();
    expect(res.judged).toBe(0);
    const after = await pool!.query<{ importance_score: string }>(
      `SELECT importance_score FROM ai_news_events WHERE event_id = $1`,
      [eventId],
    );
    expect(Number(after.rows[0]!.importance_score)).toBe(82); // 未被 11 覆写。
  });

  it('claim 后崩溃：score 仍 NULL 的僵尸 claim，未过 T 不重 claim、过 T 可重 claim', async () => {
    const { eventId } = await seedEvent('zombie');

    // 模拟「已 claim 但崩溃、score 仍 NULL」：手写 judge_claimed_at = 10 秒前。
    await pool!.query(
      `UPDATE ai_news_events SET judge_claimed_at = now() - interval '10 seconds' WHERE event_id = $1`,
      [eventId],
    );

    // reclaimMs = 30s：10s < 30s → 未过 T，不应被重新 claim（防误回收正在评分的事件）。
    const notYet = await claimEventForJudging(eventId, 30_000, db!);
    expect(notYet).toBe('skipped');

    // reclaimMs = 5s：10s > 5s → 已过 T，僵尸 claim 被重新 claim（不致永久漏评）。
    const reclaimed = await claimEventForJudging(eventId, 5_000, db!);
    expect(reclaimed).toBe('claimed');
  });

  it('评分+写分总时长 < T：claim 后立即写分，并发链路不重新 claim 误覆写', async () => {
    const { eventId, dedupKey } = await seedEvent('fast');

    // 链路 1 claim 成功（reclaimMs 大，模拟正常 T>L+W）。
    const claim1 = await claimEventForJudging(eventId, 180_000, db!);
    expect(claim1).toBe('claimed');

    // 此刻链路 2 并发尝试 claim：链路 1 刚 claim（judge_claimed_at = now()，远未到 now()-T）
    // → 链路 2 不满足回收条件 → skipped（不双评分）。
    const claim2 = await claimEventForJudging(eventId, 180_000, db!);
    expect(claim2).toBe('skipped');

    // 链路 1 写分（模拟 LLM 返回后写 *_score，总时长 < L+W < T）。写分后 importance_score 非 NULL。
    await pool!.query(
      `UPDATE ai_news_events SET importance_score = '88' WHERE event_id = $1`,
      [eventId],
    );

    // 写分后再 claim（即便小 T）也不再 claim：importance_score 非 NULL，不满足 `*_score IS NULL`。
    const afterScore = await claimEventForJudging(eventId, 1, db!);
    expect(afterScore).toBe('skipped');
    const after = await fetchScores(dedupKey);
    expect(Number(after.importance_score)).toBe(88);
  });
});
