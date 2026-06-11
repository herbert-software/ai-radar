/**
 * 统一入库集成测试（任务 4.5，源内幂等不变量）——需本地 Postgres（compose 起的库）。
 *
 * 验证：
 * - 同一源重复抓取同一条目（相同 source_item_id），第二次写入因
 *   `UNIQUE(source, source_item_id)` 冲突被跳过 → raw_items 中该源该条目仅一行（源内幂等）。
 * - 入库时即时生成 canonical_url（去追踪参数）与 title_hash，metadata 含 normalizer_version。
 * - source_item_id 为空的条目被跳过，绝不写 NULL 标识。
 *
 * 缺 DATABASE_URL 时本套件自动跳过；用唯一 source 前缀隔离，afterAll 清理本套件造的行。
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

const { storeCollectedItems } = await import('../store.js');
const { contentHash } = await import('../types.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'store-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

async function countBySourceItemId(sourceItemId: string): Promise<number> {
  const { rows } = await pool!.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM raw_items WHERE source = $1 AND source_item_id = $2`,
    [SOURCE, sourceItemId],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (pool) await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
    await pool.end();
  }
});

describe.skipIf(!databaseUrl)('统一入库（源内幂等不变量）', () => {
  it('同一 source_item_id 重复入库：第二次冲突跳过，仅一行', async () => {
    const item = {
      source: SOURCE as 'rss',
      sourceItemId: `dup-${Date.now()}`,
      url: 'https://example.com/post?utm_source=tw&id=9',
      title: 'Idempotent item',
      content: 'body',
      publishedAt: new Date('2026-06-01T00:00:00Z'),
      rawType: 'news',
    };

    const first = await storeCollectedItems([item], { dbh: db! });
    expect(first.inserted).toBe(1);
    // 有 url/title → 可处理；首轮 processableCount=1。
    expect(first.processableCount).toBe(1);

    const second = await storeCollectedItems([item], { dbh: db! });
    // 第二次冲突跳过：attempted=1 但 inserted=0。
    expect(second.attempted).toBe(1);
    expect(second.inserted).toBe(0);
    // 源内重复项仍计入 processableCount（会塌缩进既有事件）：取代 insertedIds 作告警依据（Codex C1）。
    expect(second.processableCount).toBe(1);

    expect(await countBySourceItemId(item.sourceItemId)).toBe(1);

    // 即时生成的 canonical_url 去掉了 utm_source；title_hash 与 normalizer_version 就位。
    const { rows } = await pool!.query<{
      canonical_url: string | null;
      title_hash: string | null;
      metadata: { normalizer_version?: number } | null;
    }>(
      `SELECT canonical_url, title_hash, metadata FROM raw_items
       WHERE source = $1 AND source_item_id = $2`,
      [SOURCE, item.sourceItemId],
    );
    expect(rows[0]!.canonical_url).toBe('https://example.com/post?id=9');
    expect(rows[0]!.title_hash).not.toBeNull();
    expect(rows[0]!.metadata?.normalizer_version).toBe(1);
  });

  it('source_item_id 为空 → 跳过，不写 NULL 标识', async () => {
    const logged: unknown[] = [];
    const result = await storeCollectedItems(
      [
        {
          source: SOURCE as 'rss',
          sourceItemId: '   ',
          url: null,
          title: 'no id',
          content: null,
          publishedAt: null,
          rawType: 'news',
        },
      ],
      { dbh: db!, logError: (m) => logged.push(m) },
    );
    expect(result.skippedInvalid).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.inserted).toBe(0);
    // 缺 source_item_id 被跳过、未尝试入库 → 不计入 processableCount。
    expect(result.processableCount).toBe(0);
    expect(logged.length).toBe(1);

    // 确认没有写入 NULL/空 source_item_id 行。
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM raw_items
       WHERE source = $1 AND (source_item_id IS NULL OR trim(source_item_id) = '')`,
      [SOURCE],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('collapsed 透传：默认 false；arXiv 论文置 true（入库即标已沉淀）', async () => {
    const ts = Date.now();
    const newsItem = {
      source: SOURCE as 'rss',
      sourceItemId: `collapsed-default-${ts}`,
      url: `https://example.com/n-${ts}`,
      title: 'default collapsed',
      content: null,
      publishedAt: null,
      rawType: 'news',
    };
    const paperItem = {
      source: SOURCE as 'arxiv',
      sourceItemId: `collapsed-paper-${ts}`,
      url: `https://arxiv.org/abs/2406.${ts}`,
      title: 'sunk paper',
      content: 'abstract',
      publishedAt: null,
      rawType: 'paper',
      collapsed: true,
    };
    await storeCollectedItems([newsItem, paperItem], { dbh: db! });

    const { rows } = await pool!.query<{ source_item_id: string; collapsed: boolean }>(
      `SELECT source_item_id, collapsed FROM raw_items
       WHERE source = $1 AND source_item_id IN ($2, $3)`,
      [SOURCE, newsItem.sourceItemId, paperItem.sourceItemId],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.source_item_id, r.collapsed]));
    // 新闻行默认 collapsed=false（待塌缩）；arXiv 论文行 collapsed=true（仅沉淀、不重扫）。
    expect(byId[newsItem.sourceItemId]).toBe(false);
    expect(byId[paperItem.sourceItemId]).toBe(true);
  });

  it('内容哈希 fallback 作 source_item_id 时仍源内幂等', async () => {
    const sid = contentHash('hash-title', 'hash-body');
    const item = {
      source: SOURCE as 'rss',
      sourceItemId: sid,
      url: null,
      title: 'hash-title',
      content: 'hash-body',
      publishedAt: null,
      rawType: 'news',
    };
    await storeCollectedItems([item], { dbh: db! });
    await storeCollectedItems([item], { dbh: db! });
    expect(await countBySourceItemId(sid)).toBe(1);
  });
});
