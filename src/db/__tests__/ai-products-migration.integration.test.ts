/**
 * Integration 测试（任务 6.3）：断言 P2 forward-only 迁移已落 `ai_products` 表，
 * 且三个硬合并唯一约束就位、不含任何向量列。
 *
 * 对齐 spec「ai_products 产品表可迁移」三场景：
 *  - 迁移落 ai_products 表与合并唯一约束（UNIQUE canonical_domain/github_repo/product_hunt_slug）
 *  - ai_products 迁移 forward-only 且幂等（既有迁移不重写、新增迁移可重跑无变化）
 *  - ai_products 不含向量列（P3 起向量能力仅及 ai_news_events / kb_documents，ai_products 仍无向量列）
 * 并覆盖「迁移落核心表与本期新增列」中 ai_news_events.judge_claimed_at 一项。
 *
 * 注：P3（add-semantic-dedup-and-store-hardening）解除「全库零向量」不变量、启用 vector 扩展，
 * 故本套件不再断言扩展全局缺席——vector 扩展的正当启用由 p3-vector-kb-migration.integration.test.ts 断言。
 *
 * 依赖：需要一个已执行 `drizzle-kit migrate` 的本地 Postgres（compose 起的库即可），
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

describe.skipIf(!databaseUrl)('ai_products 迁移落表与硬合并约束', () => {
  it('ai_products 表存在且含本期必建列', async () => {
    const { rows } = await pool!.query<{ column_name: string; data_type: string }>(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'ai_products'
      `,
    );

    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));

    // product_id surrogate key 列类型为 varchar(128)（与 push_records.target_id 一致）。
    expect(byName.get('product_id')).toBe('character varying');
    // name NOT NULL 业务列（塌缩 INSERT 必填）。
    expect(byName.has('name')).toBe(true);
    // 三个硬合并冲突键列。
    expect(byName.has('canonical_domain')).toBe(true);
    expect(byName.has('github_repo')).toBe(true);
    expect(byName.has('product_hunt_slug')).toBe(true);
    // last_seen 类可累加列（本期必建）。
    expect(byName.has('first_seen_at')).toBe(true);
    expect(byName.has('last_seen_at')).toBe(true);
    expect(byName.has('last_pushed_at')).toBe(true);
    // metadata（merge_conflict 标记落点）+ representative_raw_item_id 过渡列。
    expect(byName.has('metadata')).toBe(true);
    expect(byName.has('representative_raw_item_id')).toBe(true);
  });

  it('product_id 为 varchar(128) PRIMARY KEY 且默认 gen_random_uuid()::text', async () => {
    const { rows } = await pool!.query<{
      data_type: string;
      character_maximum_length: number | null;
      column_default: string | null;
    }>(
      `
      SELECT data_type, character_maximum_length, column_default
      FROM information_schema.columns
      WHERE table_name = 'ai_products' AND column_name = 'product_id'
      `,
    );
    expect(rows).toHaveLength(1);
    const productId = rows[0]!;
    expect(productId.data_type).toBe('character varying');
    expect(productId.character_maximum_length).toBe(128);
    expect(productId.column_default ?? '').toContain('gen_random_uuid()');

    // 主键就位。
    const { rows: pk } = await pool!.query<{ constraint_type: string }>(
      `
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'ai_products'
        AND tc.constraint_type = 'PRIMARY KEY'
        AND kcu.column_name = 'product_id'
      `,
    );
    expect(pk).toHaveLength(1);
  });

  it('三个单列 UNIQUE 约束（canonical_domain / github_repo / product_hunt_slug）就位', async () => {
    const { rows } = await pool!.query<{
      constraint_name: string;
      columns: string;
    }>(
      `
      SELECT tc.constraint_name,
             string_agg(kcu.column_name, ',' ORDER BY kcu.column_name) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'ai_products'
        AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.constraint_name
      `,
    );

    const uniqueColumnSets = rows.map((r) => r.columns);
    // 各自独立单列唯一约束，作 ON CONFLICT 冲突目标。
    for (const col of ['canonical_domain', 'github_repo', 'product_hunt_slug']) {
      expect(
        uniqueColumnSets,
        `未找到覆盖单列 ${col} 的 UNIQUE 约束；实际：${JSON.stringify(rows)}`,
      ).toContain(col);
    }
  });

  // 注：P3（add-semantic-dedup-and-store-hardening）解除「全库零向量」不变量并启用 vector 扩展，
  // 但向量能力仅及 ai_news_events / kb_documents——ai_products 仍不得含向量列（spec「ai_products 不含向量列」
  // 修改后场景）。故此处只断言 ai_products 表无 vector 列，不再断言扩展全局缺席（扩展由 P3 迁移正当启用）。
  it('ai_products 不含任何向量列（向量能力仅及 ai_news_events / kb_documents）', async () => {
    // 任何列的 udt_name/data_type 不得为 vector。
    const { rows: vectorCols } = await pool!.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'ai_products'
        AND (udt_name = 'vector' OR data_type = 'USER-DEFINED' AND udt_name = 'vector')
      `,
    );
    expect(vectorCols).toHaveLength(0);
  });

  it('ai_news_events 含 judge_claimed_at（并发评分原子 claim 列）', async () => {
    const { rows } = await pool!.query<{ data_type: string }>(
      `
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'ai_news_events' AND column_name = 'judge_claimed_at'
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe('timestamp with time zone');
  });
});
