/**
 * 中文摘要落库集成测试（任务 7.2/7.3）——需本地 Postgres（compose 起的库）。
 *
 * 验证关键不变量：
 * - 摘要成功 → `UPDATE ai_news_events SET summary_zh = ? WHERE event_id = ?`，
 *   只写 summary_zh，**不覆盖**塌缩首建的 representative_title /
 *   representative_raw_item_id / first_seen_at / published_at / *_score 列。
 * - 摘要降级（mock 抛错耗尽重试）→ 绝不写 summary_zh（保持 NULL），回退或剔除。
 *
 * 缺 DATABASE_URL 时本套件自动跳过（CI 在有 pg service 的 job 才跑到）。
 * 用唯一 source_item_id / dedup_key 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema.js';

// persistence.js 经 import 链间接 import config/env（启动期校验全部必填变量）。
// 本套件 mock LLM、只测落库，故为推送/LLM 相关变量注入占位；真实 DATABASE_URL 由 .env/CI 注入。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';

const { digestEvent } = await import('../persistence.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'digest-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** seed 一条 raw_item，返回其 id（bigint）。 */
async function seedRawItem(sourceItemId: string, title: string): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [SOURCE, sourceItemId, title],
  );
  return BigInt(rows[0]!.id);
}

/**
 * seed 一条已塌缩 + 已评分的 event（模拟摘要阶段的输入：塌缩首建 + Value Judge 已写分）。
 * event_id 由 DB 默认生成；返回首建快照供「不覆盖」断言对比。
 */
async function seedScoredEvent(args: {
  dedupKey: string;
  representativeRawItemId: bigint;
  representativeTitle: string;
}): Promise<{
  eventId: string;
  representativeRawItemId: string | null;
  representativeTitle: string | null;
  firstSeenAt: string | null;
  publishedAt: string | null;
  importanceScore: string | null;
}> {
  const { rows } = await pool!.query<{
    event_id: string;
    representative_raw_item_id: string | null;
    representative_title: string | null;
    first_seen_at: Date | null;
    published_at: Date | null;
    importance_score: string | null;
  }>(
    `INSERT INTO ai_news_events
       (dedup_key, representative_raw_item_id, representative_title,
        first_seen_at, last_seen_at, published_at, source_count,
        importance_score, novelty_score, developer_relevance_score, hype_risk_score, should_push)
     VALUES ($1, $2, $3, now(), now(), '2026-06-01T00:00:00Z', 1, 82, 75, 90, 35, true)
     RETURNING event_id, representative_raw_item_id, representative_title,
               first_seen_at, published_at, importance_score`,
    [args.dedupKey, args.representativeRawItemId.toString(), args.representativeTitle],
  );
  const r = rows[0]!;
  return {
    eventId: r.event_id,
    representativeRawItemId: r.representative_raw_item_id,
    representativeTitle: r.representative_title,
    firstSeenAt: r.first_seen_at?.toISOString() ?? null,
    publishedAt: r.published_at?.toISOString() ?? null,
    importanceScore: r.importance_score,
  };
}

async function fetchEvent(eventId: string) {
  const { rows } = await pool!.query<{
    summary_zh: string | null;
    headline_zh: string | null;
    representative_raw_item_id: string | null;
    representative_title: string | null;
    first_seen_at: Date | null;
    published_at: Date | null;
    importance_score: string | null;
  }>(
    `SELECT summary_zh, headline_zh, representative_raw_item_id, representative_title,
            first_seen_at, published_at, importance_score
     FROM ai_news_events WHERE event_id = $1`,
    [eventId],
  );
  return rows[0]!;
}

beforeAll(async () => {
  if (!pool) return;
  await pool.query(
    `DELETE FROM ai_news_events WHERE dedup_key LIKE $1`,
    [`${SOURCE}-%`],
  );
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${SOURCE}-%`]);
    await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
    await pool.end();
  }
});

describe.skipIf(!databaseUrl)('中文摘要落库（summary_zh UPDATE 不变量）', () => {
  it('摘要成功：写 summary_zh + headline_zh 往返一致，不覆盖首建身份/代表/时间/评分列', async () => {
    const ts = Date.now();
    const rawId = await seedRawItem(`ok-${ts}`, '代表原始标题');
    const before = await seedScoredEvent({
      dedupKey: `${SOURCE}-ok-${ts}`,
      representativeRawItemId: rawId,
      representativeTitle: '代表原始标题',
    });

    const summary = '某模型发布，新增工具调用能力，对开发者集成有直接影响。';
    const headline = '某模型发布，新增工具调用能力，便于开发者集成。';
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { summary_zh: summary, headline_zh: headline } });

    const outcome = await digestEvent(
      { eventId: before.eventId, representativeTitle: before.representativeTitle, canonicalUrl: null },
      { generateObjectFn, logError: () => {} },
      db!,
    );

    expect(outcome.status).toBe('summarized');
    expect(outcome.degraded).toBe(false);
    // digestEvent summarized 返回值含 headlineZh，与落库值一致。
    if (outcome.status === 'summarized') {
      expect(outcome.summaryZh).toBe(summary);
      expect(outcome.headlineZh).toBe(headline);
    }

    const after = await fetchEvent(before.eventId);
    // summary_zh + headline_zh 已写入经校验内容、与返回值往返一致。
    expect(after.summary_zh).toBe(summary);
    expect(after.headline_zh).toBe(headline);
    // 首建列原封不动（UPDATE set 仅含 summary_zh + headline_zh）。
    expect(after.representative_raw_item_id).toBe(before.representativeRawItemId);
    expect(after.representative_title).toBe(before.representativeTitle);
    expect(after.first_seen_at?.toISOString()).toBe(before.firstSeenAt);
    expect(after.published_at?.toISOString()).toBe(before.publishedAt);
    expect(Number(after.importance_score)).toBe(Number(before.importanceScore));
  });

  it('摘要降级：summary_zh 保持 NULL，回退 representative_title，不写未校验内容', async () => {
    const ts = Date.now();
    const rawId = await seedRawItem(`fail-${ts}`, '降级回退标题');
    const before = await seedScoredEvent({
      dedupKey: `${SOURCE}-fail-${ts}`,
      representativeRawItemId: rawId,
      representativeTitle: '降级回退标题',
    });

    const generateObjectFn = vi.fn().mockRejectedValue(new Error('LLM down'));

    const outcome = await digestEvent(
      { eventId: before.eventId, representativeTitle: before.representativeTitle, canonicalUrl: null },
      { generateObjectFn, maxAttempts: 2, logError: () => {} },
      db!,
    );

    expect(outcome).toEqual({
      eventId: before.eventId,
      status: 'fallback',
      fallbackText: '降级回退标题',
      degraded: true,
    });

    const after = await fetchEvent(before.eventId);
    // 关键不变量：降级绝不写 summary_zh / headline_zh（保持 NULL），首建列不变。
    expect(after.summary_zh).toBeNull();
    expect(after.headline_zh).toBeNull();
    expect(after.representative_title).toBe(before.representativeTitle);
    expect(Number(after.importance_score)).toBe(Number(before.importanceScore));
  });
});
