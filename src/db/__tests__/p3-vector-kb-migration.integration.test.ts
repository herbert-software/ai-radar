/**
 * Integration 测试（任务 2.4）：断言 P3 forward-only 迁移（0006_p3_vector_kb）已落
 * 向量扩展 + ai_news_events 两列 + 知识库两表，且 kb_ingestion_records 唯一约束就位。
 *
 * 对齐 platform-foundation spec「P3 向量与知识库 Schema 可迁移」两场景：
 *  - P3 迁移启用 vector 扩展与向量列（embedding vector(1536) / merged_into varchar(128)）
 *  - 新建 kb_documents / kb_ingestion_records（后者含 UNIQUE(target_type,target_id,kb_provider)）
 * 并对齐「P3 起解禁知识库表 关系/顾问表仍禁止」：四张禁表仍不存在。
 *
 * 迁移幂等（journal 级，drizzle-kit migrate 连跑两次第二次 no-op）由 CI 的 migrate step
 * 与本地 `npm run migrate` 二跑验证；本套件只读断言迁移后的结构（与 ai-products 迁移测试同范式）。
 *
 * 依赖：需要一个已执行 `drizzle-kit migrate` 的本地 Postgres（compose 起的 pgvector/pgvector 库即可），
 * 通过 DATABASE_URL 注入；不依赖真实外网、不依赖 LLM。
 * 缺 DATABASE_URL 时本套件自动跳过（CI 在有 pg service 的 job 里才会跑到）。
 *
 * 可重复运行：纯只读查询 information_schema / pg_catalog，不写任何数据。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!databaseUrl)('P3 向量与知识库迁移落库', () => {
  it('vector 扩展已启用（CREATE EXTENSION IF NOT EXISTS vector）', async () => {
    const { rows } = await pool!.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(
      rows,
      'P3 迁移须启用 vector 扩展；实际 pg_extension 未含 vector',
    ).toHaveLength(1);
  });

  it('ai_news_events 含 embedding（vector）与 merged_into（varchar(128)）列', async () => {
    const { rows } = await pool!.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      character_maximum_length: number | null;
    }>(
      `
      SELECT column_name, data_type, udt_name, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'ai_news_events'
        AND column_name IN ('embedding', 'merged_into')
      `,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    const embedding = byName.get('embedding');
    expect(embedding, 'ai_news_events.embedding 列缺失').toBeDefined();
    // pgvector 列在 information_schema 里以 USER-DEFINED + udt_name='vector' 出现。
    expect(embedding!.udt_name).toBe('vector');

    const mergedInto = byName.get('merged_into');
    expect(mergedInto, 'ai_news_events.merged_into 列缺失').toBeDefined();
    expect(mergedInto!.data_type).toBe('character varying');
    expect(mergedInto!.character_maximum_length).toBe(128);
  });

  it('ai_news_events.embedding 维度钉死 1536（design D1）', async () => {
    // pgvector 的维度存于 pg_attribute.atttypmod（无 -4 偏移，直接即维度）。
    const { rows } = await pool!.query<{ atttypmod: number }>(
      `
      SELECT a.atttypmod
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      WHERE c.relname = 'ai_news_events' AND a.attname = 'embedding'
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.atttypmod).toBe(1536);
  });

  it('kb_documents 表存在且含 spec 列（含 embedding vector）', async () => {
    const { rows } = await pool!.query<{ column_name: string; udt_name: string }>(
      `
      SELECT column_name, udt_name
      FROM information_schema.columns
      WHERE table_name = 'kb_documents'
      `,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r.udt_name]));

    for (const col of [
      'id',
      'target_type',
      'target_id',
      'kb_title',
      'summary_zh',
      'tags',
      'entities',
      'source_urls',
      'event_date',
      'long_term_value',
      'embedding',
      'created_at',
    ]) {
      expect(byName.has(col), `kb_documents 缺列 ${col}`).toBe(true);
    }
    // embedding 为 vector 类型（供未来检索）。
    expect(byName.get('embedding')).toBe('vector');
  });

  it('kb_ingestion_records 表存在且含 QA §8.7 列', async () => {
    const { rows } = await pool!.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'kb_ingestion_records'
      `,
    );
    const names = new Set(rows.map((r) => r.column_name));
    for (const col of [
      'id',
      'target_type',
      'target_id',
      'kb_provider',
      'kb_document_id',
      'status',
      'ingested_at',
      'error_message',
    ]) {
      expect(names.has(col), `kb_ingestion_records 缺列 ${col}`).toBe(true);
    }
  });

  it('kb_ingestion_records 含 UNIQUE(target_type, target_id, kb_provider)（入库幂等地基）', async () => {
    const { rows } = await pool!.query<{ columns: string }>(
      `
      SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.column_name) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'kb_ingestion_records'
        AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.constraint_name
      `,
    );
    const uniqueColumnSets = rows.map((r) => r.columns);
    // 列名按字典序聚合，故期望 kb_provider,target_id,target_type。
    expect(
      uniqueColumnSets,
      `未找到 UNIQUE(target_type,target_id,kb_provider)；实际：${JSON.stringify(rows)}`,
    ).toContain('kb_provider,target_id,target_type');
  });

  it('禁表仍不存在（item_event_relations / item_product_relations / ai_tools / task_patterns）', async () => {
    const { rows } = await pool!.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name IN (
        'item_event_relations',
        'item_product_relations',
        'ai_tools',
        'task_patterns'
      )
      `,
    );
    expect(
      rows,
      `本期禁止建关系/顾问表；实际存在：${JSON.stringify(rows)}`,
    ).toHaveLength(0);
  });

  it('ai_products 仍不含向量列（向量能力仅及 ai_news_events / kb_documents）', async () => {
    const { rows } = await pool!.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'ai_products' AND udt_name = 'vector'
      `,
    );
    expect(
      rows,
      `ai_products 不得含 vector 列；实际：${JSON.stringify(rows)}`,
    ).toHaveLength(0);
  });
});
