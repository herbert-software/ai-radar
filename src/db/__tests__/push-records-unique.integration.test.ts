/**
 * Integration 测试（任务 3.6）：断言 push_records 上的推送幂等唯一约束已就位。
 *
 * 验证 UNIQUE(target_type, target_id, channel, push_date) 在迁移后真实存在于
 * 数据库——这是「不可回退的地基」（design D3 / spec「推送幂等唯一约束就位」）。
 *
 * 依赖：需要一个已执行 `drizzle-kit migrate` 的本地 Postgres（compose 起的库即可）。
 * 通过 DATABASE_URL 注入；不依赖真实外网、不依赖 LLM。
 * 缺 DATABASE_URL 时本套件自动跳过（CI 在有 pg service 的 job 里才会跑到）。
 *
 * 可重复运行：纯只读查询 information_schema，不写任何数据。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

// 仅查询约束元数据所需的最小列集合。
const EXPECTED_COLUMNS = [
  'target_type',
  'target_id',
  'channel',
  'push_date',
].sort();

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!databaseUrl)('push_records 推送幂等唯一约束', () => {
  it('存在 UNIQUE(target_type, target_id, channel, push_date)', async () => {
    // 找出 push_records 上所有 UNIQUE 约束，及其覆盖的列集合。
    // 用 string_agg 把列名拼成逗号分隔字符串（已按列名排序），
    // 避免 node-postgres 把 array_agg 结果当作 Postgres 数组字面量字符串返回。
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
      WHERE tc.table_name = 'push_records'
        AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.constraint_name
      `,
    );

    const expected = EXPECTED_COLUMNS.join(',');
    const match = rows.find((row) => row.columns === expected);

    expect(
      match,
      `未找到覆盖列 ${EXPECTED_COLUMNS.join(', ')} 的 UNIQUE 约束；` +
        `实际 UNIQUE 约束：${JSON.stringify(rows)}`,
    ).toBeDefined();
  });
});
