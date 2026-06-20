/**
 * Integration 测试（任务 1.4）：断言 add-ai-blogger-experience-mining 的 forward-only 迁移
 * （0007_*_ai_experiences）已落 `ai_experiences` 表，且去重唯一键 / surrogate 主键 / 裸 bigint
 * provenance / 零向量 / 零二级索引 等不变量就位。
 *
 * 对齐 platform-foundation spec「ai_experiences 主键与 target_id 类型相容、去重唯一键就位」与
 * blogger-experience-mining spec「经验卡片实体表与确定性去重幂等」：
 *  - id 列类型为 varchar(128)、默认 gen_random_uuid()::text（与 push_records.target_id 类型相容）
 *  - UNIQUE(canonical_source_url) 生效（重复 URL 第二行被 ON CONFLICT 收敛 / NOT NULL 拒空）
 *  - representative_raw_item_id 裸 bigint NOT NULL 无外键
 *  - 无向量列、无二级索引（除 PK + UNIQUE 自带索引外）
 *
 * 迁移幂等（journal 级，drizzle-kit migrate 连跑两次第二次 no-op）由 CI 的 migrate step
 * 与本地 `npm run migrate` 二跑验证；本套件只读断言迁移后的结构 + 一处写入断言 ON CONFLICT/NOT NULL
 * 行为（与 ai-products / p3-vector-kb 迁移测试同范式）。
 *
 * 依赖：需要一个已执行 `drizzle-kit migrate` 的本地 Postgres（compose 起的 pgvector/pgvector 库即可），
 * 通过 DATABASE_URL 注入；不依赖真实外网、不依赖 LLM。
 * 缺 DATABASE_URL 时本套件自动跳过（CI 在有 pg service 的 job 里才会跑到）。
 *
 * 写入断言用唯一前缀 URL + afterAll 清理，可重复运行不互相污染。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

// 本套件写入断言用的唯一来源 URL 前缀（afterAll 据此清理，避免污染其它套件 / 重复运行冲突）。
const TEST_URL_PREFIX =
  'https://test.example.invalid/ai-experiences-migration-it/';

afterAll(async () => {
  if (pool) {
    await pool.query(
      `DELETE FROM ai_experiences WHERE canonical_source_url LIKE $1`,
      [`${TEST_URL_PREFIX}%`],
    );
  }
  await pool?.end();
});

describe.skipIf(!databaseUrl)('ai_experiences 迁移落表与去重约束', () => {
  it('ai_experiences 表存在且含本期必建列', async () => {
    const { rows } = await pool!.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'ai_experiences'
      `,
    );
    const names = new Set(rows.map((r) => r.column_name));
    for (const col of [
      'id',
      'canonical_source_url',
      'representative_raw_item_id',
      'scenario',
      'tools',
      'techniques',
      'applicability',
      'long_term_value',
      'headline_zh',
      'summary_zh',
      'published_at',
      'created_at',
    ]) {
      expect(names.has(col), `ai_experiences 缺列 ${col}`).toBe(true);
    }
  });

  it('id 为 varchar(128) PRIMARY KEY 且默认 gen_random_uuid()::text（与 push_records.target_id 类型相容）', async () => {
    const { rows } = await pool!.query<{
      data_type: string;
      character_maximum_length: number | null;
      column_default: string | null;
      is_nullable: string;
    }>(
      `
      SELECT data_type, character_maximum_length, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ai_experiences' AND column_name = 'id'
      `,
    );
    expect(rows).toHaveLength(1);
    const id = rows[0]!;
    expect(id.data_type).toBe('character varying');
    expect(id.character_maximum_length).toBe(128);
    expect(id.column_default ?? '').toContain('gen_random_uuid()');
    expect(id.is_nullable).toBe('NO');

    // 主键就位。
    const { rows: pk } = await pool!.query<{ constraint_type: string }>(
      `
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'ai_experiences'
        AND tc.constraint_type = 'PRIMARY KEY'
        AND kcu.column_name = 'id'
      `,
    );
    expect(pk).toHaveLength(1);
  });

  it('UNIQUE(canonical_source_url) 约束就位（去重 ON CONFLICT 冲突目标）', async () => {
    const { rows } = await pool!.query<{ columns: string }>(
      `
      SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.column_name) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'ai_experiences'
        AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.constraint_name
      `,
    );
    const uniqueColumnSets = rows.map((r) => r.columns);
    expect(
      uniqueColumnSets,
      `未找到 UNIQUE(canonical_source_url)；实际：${JSON.stringify(rows)}`,
    ).toContain('canonical_source_url');
  });

  it('canonical_source_url NOT NULL（拒空）', async () => {
    const { rows } = await pool!.query<{ is_nullable: string }>(
      `
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ai_experiences' AND column_name = 'canonical_source_url'
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe('NO');

    // 写入断言：canonical_source_url 为 NULL 被 NOT NULL 拒绝。
    await expect(
      pool!.query(
        `INSERT INTO ai_experiences (canonical_source_url, representative_raw_item_id, long_term_value)
         VALUES (NULL, 1, 80)`,
      ),
    ).rejects.toThrow();
  });

  it('重复 canonical_source_url 第二行被 ON CONFLICT (canonical_source_url) 收敛（仅一行）', async () => {
    const url = `${TEST_URL_PREFIX}conflict`;
    // 第一次插入。
    await pool!.query(
      `INSERT INTO ai_experiences (canonical_source_url, representative_raw_item_id, long_term_value)
       VALUES ($1, 100, 80)
       ON CONFLICT (canonical_source_url) DO NOTHING`,
      [url],
    );
    // 同 URL 再插（经不同 feed 采到不同 raw_item，representative_raw_item_id 不同）→ ON CONFLICT 收敛。
    await pool!.query(
      `INSERT INTO ai_experiences (canonical_source_url, representative_raw_item_id, long_term_value)
       VALUES ($1, 200, 90)
       ON CONFLICT (canonical_source_url) DO NOTHING`,
      [url],
    );
    const { rows } = await pool!.query<{ representative_raw_item_id: string }>(
      `SELECT representative_raw_item_id FROM ai_experiences WHERE canonical_source_url = $1`,
      [url],
    );
    // 仅一行存在，且为第一条命中的代表（DO NOTHING 不覆盖）。
    expect(rows).toHaveLength(1);
    expect(rows[0]!.representative_raw_item_id).toBe('100');
  });

  it('representative_raw_item_id 为裸 bigint NOT NULL 且无外键', async () => {
    const { rows: col } = await pool!.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ai_experiences'
        AND column_name = 'representative_raw_item_id'
      `,
    );
    expect(col).toHaveLength(1);
    expect(col[0]!.data_type).toBe('bigint');
    expect(col[0]!.is_nullable).toBe('NO');

    // ai_experiences 整表无任何外键约束（对齐基线零 FK 惯例）。
    const { rows: fks } = await pool!.query<{ constraint_name: string }>(
      `
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'ai_experiences'
        AND constraint_type = 'FOREIGN KEY'
      `,
    );
    expect(
      fks,
      `ai_experiences 不得有外键；实际：${JSON.stringify(fks)}`,
    ).toHaveLength(0);
  });

  it('无向量列（对齐基线惯例——向量能力仅及 ai_news_events / kb_documents）', async () => {
    const { rows } = await pool!.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'ai_experiences' AND udt_name = 'vector'
      `,
    );
    expect(
      rows,
      `ai_experiences 不得含 vector 列；实际：${JSON.stringify(rows)}`,
    ).toHaveLength(0);
  });

  it('无二级索引（仅 PK + UNIQUE(canonical_source_url) 自带索引）', async () => {
    const { rows } = await pool!.query<{ indexname: string }>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'ai_experiences'
      `,
    );
    const indexNames = rows.map((r) => r.indexname).sort();
    // 仅两个系统约束自带索引：主键 + canonical_source_url 唯一约束。无任何额外二级索引。
    expect(indexNames).toEqual([
      'ai_experiences_canonical_source_url_key',
      'ai_experiences_pkey',
    ]);
  });
});
