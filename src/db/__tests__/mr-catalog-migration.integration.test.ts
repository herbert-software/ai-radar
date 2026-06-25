/**
 * Integration 测试（tasks 3.1–3.8、4.2）：断言 add-model-radar-data-model（5a）的 forward-only
 * 迁移（0008_*）已落 11 张 `mr_*` 表，且全部唯一约束 / NOT NULL / 刻意可空 / 零-FK / PK 类型相容
 * 等结构不变量就位；并以**写隔离数据 + afterAll 清理**验证去重塌缩、CAS upsert、兼容矩阵 join、
 * 价格历史 append、needs_login_recheck 占位、跨厂同名 family 不误合等行为，及 mr-schema.zod 取值闸。
 *
 * 范式（对齐 ai-experiences / ai-products / p3-vector-kb 迁移测试，design D7）：
 *  - **结构断言**走 information_schema / pg_catalog 只读；
 *  - **行为/往返断言**写隔离数据（唯一前缀）+ afterAll 清理；
 *  - 迁移幂等不在 test 内重跑（journal no-op 由 `npm run migrate` 二跑 + CI migrate step 覆盖）。
 *
 * numeric 列 node-pg 读回为**字符串**，断言用字符串归一比对。
 * 缺 DATABASE_URL 时自动跳过（CI 在有 pg service 的 job 里才会跑到）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  mrCategorySchema,
  mrClientTypeSchema,
  mrCurrencySchema,
  mrFetchStrategySchema,
  mrLimitTypeSchema,
  mrPlanWriteSchema,
  mrReviewFlagStatusSchema,
  mrReviewFlagTargetTypeSchema,
  mrSourceConfidenceSchema,
} from '../mr-schema.zod.js';
import {
  QIANFAN_LAST_CHECKED,
  QIANFAN_SOURCE_URL,
  qianfanModels,
  qianfanPlans,
  qianfanPriceHistory,
  qianfanSource,
  qianfanVendor,
} from './fixtures/mr-sample-qianfan.js';

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

// 行为/往返测试造行的隔离前缀（afterAll 据此清理，可重复运行不互相污染）。
// 厂商 normalized_name 与 source_url 都以此前缀打头，删 vendor 后按 vendor_id 级联手删子行。
// 千帆 fixture 自带 'mr-it-qianfan/' 前缀，cleanup 一并清理（见下）。
const IT_PREFIX = 'mr-it/';

/**
 * 删除所有以 IT 前缀造的 mr_* 行。零-FK 无级联，按依赖顺序手删：
 * 先删引用 plan/vendor 的子行，再删 plan、model、source、vendor。
 * 用 vendor_id 子查询定位（前缀只挂在 vendor.normalized_name / source_url 上）。
 */
async function cleanup(): Promise<void> {
  if (!pool) return;
  const vendorIds = `(
    SELECT id FROM mr_vendors WHERE normalized_name LIKE '${IT_PREFIX}%'
       OR normalized_name LIKE 'mr-it-qianfan/%'
  )`;
  const planIds = `(SELECT id FROM mr_plans WHERE vendor_id IN ${vendorIds})`;
  const sourceIds = `(SELECT id FROM mr_source WHERE vendor_id IN ${vendorIds})`;
  const modelIds = `(SELECT id FROM mr_models WHERE vendor_id IN ${vendorIds})`;
  await pool.query(`DELETE FROM mr_plan_models WHERE plan_id IN ${planIds}`);
  await pool.query(`DELETE FROM mr_plan_clients WHERE plan_id IN ${planIds}`);
  await pool.query(`DELETE FROM mr_plan_limits WHERE plan_id IN ${planIds}`);
  await pool.query(`DELETE FROM mr_price_history WHERE plan_id IN ${planIds}`);
  await pool.query(`DELETE FROM mr_plan_sources WHERE plan_id IN ${planIds} OR source_id IN ${sourceIds}`);
  await pool.query(
    `DELETE FROM mr_review_flag WHERE target_id IN ${planIds} OR target_id IN ${sourceIds} OR target_id IN ${vendorIds}`,
  );
  await pool.query(`DELETE FROM mr_plans WHERE id IN ${planIds}`);
  await pool.query(`DELETE FROM mr_source WHERE id IN ${sourceIds}`);
  await pool.query(`DELETE FROM mr_models WHERE id IN ${modelIds}`);
  await pool.query(`DELETE FROM mr_vendors WHERE id IN ${vendorIds}`);
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool?.end();
});

/** 造一个隔离厂商，返回 vendor id。 */
async function insertVendor(slug: string, name = slug): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO mr_vendors (normalized_name, name) VALUES ($1, $2) RETURNING id`,
    [`${IT_PREFIX}${slug}`, name],
  );
  return rows[0]!.id;
}

/** 造一个隔离 plan，返回 plan id。provenance 用 fixture 默认值。 */
async function insertPlan(
  vendorId: string,
  name: string,
  category = 'coding_plan',
): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO mr_plans
       (vendor_id, name, category, current_price, currency, source_url, last_checked, source_confidence)
     VALUES ($1, $2, $3, '40.00', 'CNY', $4, $5, 'official_doc')
     RETURNING id`,
    [vendorId, `${IT_PREFIX}${name}`, category, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
  );
  return rows[0]!.id;
}

// ───────────────────────────── 3.1 结构断言（只读） ─────────────────────────────

describe.skipIf(!databaseUrl)('3.1 mr_* 落表与结构不变量（information_schema 只读）', () => {
  const ALL_TABLES = [
    'mr_vendors',
    'mr_models',
    'mr_plans',
    'mr_plan_models',
    'mr_plan_clients',
    'mr_plan_limits',
    'mr_price_history',
    'mr_source',
    'mr_plan_sources',
    'mr_review_flag',
    'mr_catalog_version',
  ];

  it('逐一点名全部 11 张 mr_* 表存在', async () => {
    const { rows } = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)`,
      [ALL_TABLES],
    );
    const present = new Set(rows.map((r) => r.table_name));
    for (const t of ALL_TABLES) {
      expect(present.has(t), `缺表 ${t}`).toBe(true);
    }
    expect(present.size).toBe(11);
  });

  it('全部命名唯一约束逐一就位且为精确集（恰 11 条、无多余、命名表级 *_key）', async () => {
    // 读所有 mr_* 表 UNIQUE 约束（含约束名 + 覆盖列集合，按列名排序聚合）。
    const { rows } = await pool!.query<{
      table_name: string;
      constraint_name: string;
      columns: string;
    }>(
      `
      SELECT tc.table_name,
             tc.constraint_name,
             string_agg(kcu.column_name, ',' ORDER BY kcu.column_name) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name LIKE 'mr_%'
        AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.table_name, tc.constraint_name
      `,
    );
    // 期望集（列按字典序）。D12 逐一钉死；spec.md:117 要求逐一列举的命名表级约束。
    const expected: Record<string, string> = {
      mr_vendors: 'normalized_name',
      mr_models: 'family,vendor_id,version',
      mr_plans: 'name,vendor_id',
      mr_plan_models: 'model_id,plan_id',
      mr_plan_clients: 'client_id,client_type,plan_id',
      mr_plan_limits: 'limit_type,plan_id,window',
      mr_price_history: 'changed_at,plan_id',
      mr_source: 'source_url,vendor_id',
      mr_plan_sources: 'plan_id,source_id',
      mr_review_flag: 'target_id,target_type',
      mr_catalog_version: 'version',
    };
    // 精确集：恰 11 条 mr_* UNIQUE 约束，多一条（第 12 条意外约束）即红。
    expect(
      rows.length,
      `mr_* UNIQUE 约束应恰 11 条；实际 ${rows.length}：${JSON.stringify(
        rows.map((r) => `${r.table_name}.${r.constraint_name}(${r.columns})`),
      )}`,
    ).toBe(Object.keys(expected).length);
    // 每张表恰一条 UNIQUE——堵住「同表 2 约束 + 另表 0 约束」仍凑成 11 行、被 fromEntries last-wins 掩盖的边角。
    expect(
      new Set(rows.map((r) => r.table_name)).size,
      '每张表应恰一条 mr_* UNIQUE 约束（无同表多约束）',
    ).toBe(Object.keys(expected).length);
    // (table → 排序后列组) 实际集与期望 map 完全相等（不止包含、要相等）。
    const actual = Object.fromEntries(rows.map((r) => [r.table_name, r.columns]));
    expect(actual).toEqual(expected);
    // 每条约束名匹配 *_key（命名表级 unique('<name>').on(...) 的证据；列级/匿名约束不会命中）。
    for (const r of rows) {
      expect(
        r.constraint_name,
        `${r.table_name} 的 UNIQUE 约束名应为命名表级 *_key 形式；实际：${r.constraint_name}`,
      ).toMatch(/_key$/);
    }
  });

  it('全部声明为 NOT NULL 的列 is_nullable=NO（键组件 + 非键 provenance/审计列）', async () => {
    // (table, column) NOT NULL 期望集——覆盖 D12 键组件 + 非键 NOT NULL（provenance 三元 / price_history
    // 五列 / category / created_at / updated_at / opened_at），防 NOT NULL 漏实现假绿。
    const notNullCols: Array<[string, string]> = [
      // mr_vendors
      ['mr_vendors', 'normalized_name'],
      ['mr_vendors', 'name'],
      ['mr_vendors', 'created_at'],
      // mr_models
      ['mr_models', 'vendor_id'],
      ['mr_models', 'family'],
      ['mr_models', 'version'],
      ['mr_models', 'created_at'],
      // mr_plans（含 category + provenance 三元 + 审计）
      ['mr_plans', 'vendor_id'],
      ['mr_plans', 'name'],
      ['mr_plans', 'category'],
      ['mr_plans', 'source_url'],
      ['mr_plans', 'last_checked'],
      ['mr_plans', 'source_confidence'],
      ['mr_plans', 'created_at'],
      ['mr_plans', 'updated_at'],
      // mr_plan_models（provenance 三元）
      ['mr_plan_models', 'plan_id'],
      ['mr_plan_models', 'model_id'],
      ['mr_plan_models', 'source_url'],
      ['mr_plan_models', 'last_checked'],
      ['mr_plan_models', 'source_confidence'],
      ['mr_plan_models', 'created_at'],
      // mr_plan_clients（provenance 三元）
      ['mr_plan_clients', 'plan_id'],
      ['mr_plan_clients', 'client_type'],
      ['mr_plan_clients', 'client_id'],
      ['mr_plan_clients', 'source_url'],
      ['mr_plan_clients', 'last_checked'],
      ['mr_plan_clients', 'source_confidence'],
      ['mr_plan_clients', 'created_at'],
      // mr_plan_limits（provenance 三元 + 审计；value 刻意可空，window NOT NULL 哨兵）
      ['mr_plan_limits', 'plan_id'],
      ['mr_plan_limits', 'limit_type'],
      ['mr_plan_limits', 'window'],
      ['mr_plan_limits', 'source_url'],
      ['mr_plan_limits', 'last_checked'],
      ['mr_plan_limits', 'source_confidence'],
      ['mr_plan_limits', 'created_at'],
      ['mr_plan_limits', 'updated_at'],
      // mr_price_history（new_value / currency / changed_at / source_url / source_confidence）
      ['mr_price_history', 'plan_id'],
      ['mr_price_history', 'new_value'],
      ['mr_price_history', 'currency'],
      ['mr_price_history', 'changed_at'],
      ['mr_price_history', 'source_url'],
      ['mr_price_history', 'source_confidence'],
      ['mr_price_history', 'created_at'],
      // mr_source（last_checked 刻意可空）
      ['mr_source', 'source_url'],
      ['mr_source', 'vendor_id'],
      ['mr_source', 'fetch_strategy'],
      ['mr_source', 'created_at'],
      // mr_plan_sources
      ['mr_plan_sources', 'source_id'],
      ['mr_plan_sources', 'plan_id'],
      ['mr_plan_sources', 'created_at'],
      // mr_review_flag（reason / resolved_at 刻意可空）
      ['mr_review_flag', 'target_type'],
      ['mr_review_flag', 'target_id'],
      ['mr_review_flag', 'status'],
      ['mr_review_flag', 'opened_at'],
      ['mr_review_flag', 'created_at'],
      // mr_catalog_version
      ['mr_catalog_version', 'version'],
      ['mr_catalog_version', 'built_at'],
      ['mr_catalog_version', 'created_at'],
    ];
    const { rows } = await pool!.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name LIKE 'mr_%'`,
    );
    const nullableByKey = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]),
    );
    for (const [t, c] of notNullCols) {
      expect(
        nullableByKey.get(`${t}.${c}`),
        `${t}.${c} 应为 NOT NULL（is_nullable=NO），实际：${nullableByKey.get(`${t}.${c}`)}`,
      ).toBe('NO');
    }
  });

  it('刻意可空列 is_nullable=YES（needs_login_recheck 占位 / 未抓过等路径）', async () => {
    const nullableCols: Array<[string, string]> = [
      ['mr_plans', 'current_price'],
      ['mr_plans', 'currency'],
      ['mr_plan_limits', 'value'],
      ['mr_price_history', 'old_value'],
      ['mr_review_flag', 'reason'],
      ['mr_review_flag', 'resolved_at'],
      ['mr_source', 'last_checked'],
      ['mr_source', 'content_fingerprint'],
    ];
    const { rows } = await pool!.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name LIKE 'mr_%'`,
    );
    const byKey = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]),
    );
    for (const [t, c] of nullableCols) {
      expect(
        byKey.get(`${t}.${c}`),
        `${t}.${c} 应刻意可空（is_nullable=YES），实际：${byKey.get(`${t}.${c}`)}`,
      ).toBe('YES');
    }
  });

  it('varchar(128) PK / target_id 列 character_maximum_length=128', async () => {
    // 全部 mr_* id PK 与 mr_review_flag.target_id + 各引用列均 varchar(128)。
    const cols: Array<[string, string]> = [
      ...ALL_TABLES.map((t) => [t, 'id'] as [string, string]),
      ['mr_review_flag', 'target_id'],
      ['mr_models', 'vendor_id'],
      ['mr_plans', 'vendor_id'],
      ['mr_plan_models', 'plan_id'],
      ['mr_plan_models', 'model_id'],
      ['mr_plan_clients', 'plan_id'],
      ['mr_plan_limits', 'plan_id'],
      ['mr_price_history', 'plan_id'],
      ['mr_source', 'vendor_id'],
      ['mr_plan_sources', 'source_id'],
      ['mr_plan_sources', 'plan_id'],
    ];
    const { rows } = await pool!.query<{
      table_name: string;
      column_name: string;
      character_maximum_length: number | null;
      data_type: string;
    }>(
      `SELECT table_name, column_name, character_maximum_length, data_type
       FROM information_schema.columns
       WHERE table_name LIKE 'mr_%'`,
    );
    const byKey = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );
    for (const [t, c] of cols) {
      const col = byKey.get(`${t}.${c}`);
      expect(col, `${t}.${c} 列缺失`).toBeDefined();
      expect(col!.data_type, `${t}.${c} 应为 character varying`).toBe(
        'character varying',
      );
      expect(
        col!.character_maximum_length,
        `${t}.${c} 应 varchar(128)`,
      ).toBe(128);
    }
  });

  it('mr_plan_limits.value 为无精度 numeric（禁 integer），价格列为 numeric(12,2)', async () => {
    const { rows } = await pool!.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_name LIKE 'mr_%'
         AND column_name IN ('value', 'current_price', 'old_value', 'new_value')`,
    );
    const byKey = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );
    // value 为无精度 numeric：data_type=numeric 且 precision 为 NULL（防 int32 溢出）。
    const value = byKey.get('mr_plan_limits.value')!;
    expect(value.data_type).toBe('numeric');
    expect(value.numeric_precision).toBeNull();
    // 价格列均 numeric(12,2)。
    for (const key of [
      'mr_plans.current_price',
      'mr_price_history.old_value',
      'mr_price_history.new_value',
    ]) {
      const col = byKey.get(key)!;
      expect(col.data_type, `${key} 应 numeric`).toBe('numeric');
      expect(col.numeric_precision, `${key} 精度`).toBe(12);
      expect(col.numeric_scale, `${key} 标度`).toBe(2);
    }
  });

  it('无 mr_plans.quota INT 列（额度只走 mr_plan_limits）', async () => {
    const { rows } = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'mr_plans' AND column_name = 'quota'`,
    );
    expect(rows, '不得有 mr_plans.quota 列').toHaveLength(0);
  });

  it('mr_* 整体无外键（零-FK 惯例，镜像 ai_experiences）', async () => {
    const { rows } = await pool!.query<{ table_name: string; constraint_name: string }>(
      `SELECT table_name, constraint_name
       FROM information_schema.table_constraints
       WHERE table_name LIKE 'mr_%' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows, `mr_* 不得有任何外键；实际：${JSON.stringify(rows)}`).toHaveLength(0);
  });

  it('mr_review_flag.target_id 与各身份表 PK 同 data_type（多态引用相容）', async () => {
    const { rows } = await pool!.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE (table_name = 'mr_review_flag' AND column_name = 'target_id')
          OR (table_name IN ('mr_plans', 'mr_source', 'mr_vendors') AND column_name = 'id')`,
    );
    const types = new Set(rows.map((r) => r.data_type));
    // 目标 id 与 plan/source/vendor 三身份表 PK 同型，故只剩一个 data_type。
    expect(types.size, `应统一为单一 data_type；实际：${JSON.stringify(rows)}`).toBe(1);
    expect([...types][0]).toBe('character varying');
  });

  it('既有表（ai_products / ai_news_events / push_records）结构未变（关键列与类型保持）', async () => {
    // 5a 迁移仅 CREATE TABLE mr_*，不 ALTER 既有表。抽样断言既有表关键列仍在且类型不变。
    const expectedExisting: Record<string, Record<string, string>> = {
      ai_products: {
        product_id: 'character varying',
        name: 'character varying',
        canonical_domain: 'character varying',
        github_repo: 'character varying',
        product_hunt_slug: 'character varying',
      },
      ai_news_events: {
        event_id: 'character varying',
        dedup_key: 'text',
        embedding: 'USER-DEFINED',
        merged_into: 'character varying',
      },
      push_records: {
        target_type: 'character varying',
        target_id: 'character varying',
        channel: 'character varying',
        push_date: 'date',
        status: 'character varying',
      },
    };
    for (const [table, cols] of Object.entries(expectedExisting)) {
      const { rows } = await pool!.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
      for (const [col, type] of Object.entries(cols)) {
        expect(byName.get(col), `${table}.${col} 应仍为 ${type}`).toBe(type);
      }
    }
    // 既有表不得新增任何 mr_* 相关列（抽样：none）；并确认 ai_products 仍无 vector 列等已由其它套件覆盖。
  });
});

// ───────────────────────────── 3.2 异构限额共存 + 重复拒 ─────────────────────────────

describe.skipIf(!databaseUrl)('3.2 异构额度共存 + 重复 (plan_id,limit_type,window) 拒', () => {
  it('rolling 5h / monthly 900亿 / weekly / none(NULL) 四类共存，numeric 不溢出', async () => {
    const vendorId = await insertVendor('limits-vendor');
    const planId = await insertPlan(vendorId, 'limits-plan');
    const big = '90000000000'; // 900 亿，超 int32，numeric 容
    const limits: Array<[string, string | null, string]> = [
      ['rolling_5h_requests', '6000', '5h'],
      ['monthly_tokens', big, 'month'],
      ['weekly_messages', '500', 'week'],
      ['none', null, 'none'],
    ];
    for (const [type, value, win] of limits) {
      await pool!.query(
        `INSERT INTO mr_plan_limits
           (plan_id, limit_type, value, "window", source_url, last_checked, source_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, 'official_doc')`,
        [planId, type, value, win, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    }
    const { rows } = await pool!.query<{ limit_type: string; value: string | null }>(
      `SELECT limit_type, value FROM mr_plan_limits WHERE plan_id = $1 ORDER BY limit_type`,
      [planId],
    );
    expect(rows).toHaveLength(4);
    const byType = new Map(rows.map((r) => [r.limit_type, r.value]));
    expect(byType.get('monthly_tokens')).toBe(big); // 900 亿读回字符串不溢出
    expect(Number(byType.get('rolling_5h_requests'))).toBe(6000);
    expect(byType.get('none')).toBeNull(); // 不限行 value NULL
  });

  it('重复 (plan_id, monthly_tokens, month) 第二条被唯一约束拒', async () => {
    const vendorId = await insertVendor('limits-dup-vendor');
    const planId = await insertPlan(vendorId, 'limits-dup-plan');
    const ins = (value: string) =>
      pool!.query(
        `INSERT INTO mr_plan_limits
           (plan_id, limit_type, value, "window", source_url, last_checked, source_confidence)
         VALUES ($1, 'monthly_tokens', $2, 'month', $3, $4, 'official_doc')`,
        [planId, value, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    await ins('1000');
    await expect(ins('2000')).rejects.toThrow();
  });

  it('重复 (plan_id, none, none) 第二条被唯一约束拒（不限每 plan 恰一行）', async () => {
    const vendorId = await insertVendor('limits-none-vendor');
    const planId = await insertPlan(vendorId, 'limits-none-plan');
    const insNone = () =>
      pool!.query(
        `INSERT INTO mr_plan_limits
           (plan_id, limit_type, value, "window", source_url, last_checked, source_confidence)
         VALUES ($1, 'none', NULL, 'none', $2, $3, 'official_doc')`,
        [planId, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    await insNone();
    await expect(insNone()).rejects.toThrow();
  });
});

// ───────────────────────────── 3.3 兼容矩阵 join 过滤 ─────────────────────────────

describe.skipIf(!databaseUrl)('3.3 兼容矩阵 join 过滤 + 工具/协议同名不撞', () => {
  it('join mr_plan_models × mr_plan_clients 过滤「含模型 X 且支持工具 Y」', async () => {
    const vendorId = await insertVendor('matrix-vendor');
    // 两个 plan：A 含 model-x + tool-y；B 含 model-x 但只支持 protocol-y。
    const planA = await insertPlan(vendorId, 'matrix-plan-a');
    const planB = await insertPlan(vendorId, 'matrix-plan-b');
    const { rows: mr } = await pool!.query<{ id: string }>(
      `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'matrixfam', 'x') RETURNING id`,
      [vendorId],
    );
    const modelX = mr[0]!.id;
    const linkModel = (planId: string) =>
      pool!.query(
        `INSERT INTO mr_plan_models (plan_id, model_id, source_url, last_checked, source_confidence)
         VALUES ($1, $2, $3, $4, 'official_doc')`,
        [planId, modelX, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    await linkModel(planA);
    await linkModel(planB);
    const linkClient = (planId: string, type: string, id: string) =>
      pool!.query(
        `INSERT INTO mr_plan_clients (plan_id, client_type, client_id, source_url, last_checked, source_confidence)
         VALUES ($1, $2, $3, $4, $5, 'official_doc')`,
        [planId, type, id, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    await linkClient(planA, 'tool', 'matrix-y');
    await linkClient(planB, 'protocol', 'matrix-y'); // 同名但协议端

    // 查「含 modelX 且支持 tool matrix-y」→ 只命中 planA。
    const { rows } = await pool!.query<{ id: string }>(
      `SELECT DISTINCT p.id
       FROM mr_plans p
       JOIN mr_plan_models pm ON pm.plan_id = p.id AND pm.model_id = $1
       JOIN mr_plan_clients pc ON pc.plan_id = p.id AND pc.client_type = 'tool' AND pc.client_id = 'matrix-y'`,
      [modelX],
    );
    expect(rows.map((r) => r.id)).toEqual([planA]);
  });

  it('同名 client_id 经 client_type 区分不撞唯一键（tool vs protocol 共存）', async () => {
    const vendorId = await insertVendor('client-name-vendor');
    const planId = await insertPlan(vendorId, 'client-name-plan');
    const link = (type: string) =>
      pool!.query(
        `INSERT INTO mr_plan_clients (plan_id, client_type, client_id, source_url, last_checked, source_confidence)
         VALUES ($1, $2, 'OpenAI', $3, $4, 'official_doc')`,
        [planId, type, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    await link('protocol');
    await link('tool'); // 同 plan 同名 OpenAI，但 client_type 不同 → 不撞
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM mr_plan_clients WHERE plan_id = $1 AND client_id = 'OpenAI'`,
      [planId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

// ───────────────────────────── 3.4 价格历史 append ─────────────────────────────

describe.skipIf(!databaseUrl)('3.4 价格历史 append + currency NOT NULL + 旧值仍在', () => {
  it('改价追加行（currency NOT NULL），旧值留痕，读回 source_confidence', async () => {
    const vendorId = await insertVendor('price-vendor');
    const planId = await insertPlan(vendorId, 'price-plan');
    const appendHistory = (
      oldV: string | null,
      newV: string,
      changedAt: string,
      conf: string,
    ) =>
      pool!.query(
        `INSERT INTO mr_price_history
           (plan_id, old_value, new_value, currency, changed_at, source_url, source_confidence)
         VALUES ($1, $2, $3, 'CNY', $4, $5, $6)`,
        [planId, oldV, newV, changedAt, QIANFAN_SOURCE_URL, conf],
      );
    await appendHistory(null, '40.00', '2026-06-01T00:00:00.000Z', 'official_doc');
    await appendHistory('40.00', '45.00', '2026-06-10T00:00:00.000Z', 'official_pricing');

    const { rows } = await pool!.query<{
      old_value: string | null;
      new_value: string;
      currency: string;
      source_confidence: string;
    }>(
      `SELECT old_value, new_value, currency, source_confidence
       FROM mr_price_history WHERE plan_id = $1 ORDER BY changed_at`,
      [planId],
    );
    expect(rows).toHaveLength(2);
    // 旧值 ¥40 仍在（第二行 old_value）。
    expect(rows[1]!.old_value).toBe('40.00');
    expect(rows[1]!.new_value).toBe('45.00');
    expect(rows[1]!.currency).toBe('CNY');
    expect(rows[1]!.source_confidence).toBe('official_pricing');
  });

  it('currency NULL 被 NOT NULL 拒（new_value 必有确值 ⇒ 必有币种）', async () => {
    const vendorId = await insertVendor('price-cur-vendor');
    const planId = await insertPlan(vendorId, 'price-cur-plan');
    await expect(
      pool!.query(
        `INSERT INTO mr_price_history
           (plan_id, old_value, new_value, currency, changed_at, source_url, source_confidence)
         VALUES ($1, NULL, '40.00', NULL, $2, $3, 'official_doc')`,
        [planId, QIANFAN_LAST_CHECKED, QIANFAN_SOURCE_URL],
      ),
    ).rejects.toThrow();
  });
});

// ───────────────────────────── 3.5 待复核 CAS upsert ─────────────────────────────

describe.skipIf(!databaseUrl)('3.5 mr_review_flag CAS 单语句 upsert（D10 写契约）', () => {
  it('首次插 pending → 再 upsert 收敛单行 reason 刷新 → resolve 后 upsert 回 pending', async () => {
    const vendorId = await insertVendor('flag-vendor');
    const planId = await insertPlan(vendorId, 'flag-plan');
    // D10 写契约：无条件 ON CONFLICT DO UPDATE，刷新 reason / opened_at，清 resolved_at。
    const upsert = (reason: string) =>
      pool!.query(
        `INSERT INTO mr_review_flag (target_type, target_id, reason, status)
         VALUES ('plan', $1, $2, 'pending')
         ON CONFLICT (target_type, target_id)
         DO UPDATE SET status='pending', reason=excluded.reason, opened_at=now(), resolved_at=NULL`,
        [planId, reason],
      );
    const read = () =>
      pool!.query<{
        n: string;
        status: string;
        reason: string | null;
        resolved_at: string | null;
      }>(
        `SELECT count(*) OVER () AS n, status, reason, resolved_at
         FROM mr_review_flag WHERE target_type='plan' AND target_id=$1`,
        [planId],
      );

    // 1) 首次插 pending。
    await upsert('fingerprint-changed');
    let { rows } = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.reason).toBe('fingerprint-changed');

    // 2) 仍 pending 时再 upsert：收敛单行（不抛 UNIQUE），reason 被刷新。
    await upsert('price-mismatch');
    ({ rows } = await read());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('price-mismatch');
    expect(rows[0]!.resolved_at).toBeNull();

    // 3) resolve（plain UPDATE）→ status=resolved, resolved_at 设值。
    await pool!.query(
      `UPDATE mr_review_flag SET status='resolved', resolved_at=now()
       WHERE target_type='plan' AND target_id=$1`,
      [planId],
    );
    ({ rows } = await read());
    expect(rows[0]!.status).toBe('resolved');
    expect(rows[0]!.resolved_at).not.toBeNull();

    // 4) resolved 后再 upsert：翻回 pending、清 resolved_at，仍单行（不产生第二行）。
    await upsert('reopened');
    ({ rows } = await read());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.reason).toBe('reopened');
    expect(rows[0]!.resolved_at).toBeNull();
  });
});

// ───────────────────────────── 3.6 唯一键兜底 ─────────────────────────────

describe.skipIf(!databaseUrl)('3.6 重复唯一键由 DB 约束拒（无 LLM）', () => {
  it('mr_vendors 重复 normalized_name 被拒', async () => {
    await insertVendor('dup-norm', 'A');
    await expect(insertVendor('dup-norm', 'B')).rejects.toThrow();
  });

  it('mr_plans 重复 (vendor_id, name) 被拒', async () => {
    const vendorId = await insertVendor('dup-plan-vendor');
    await insertPlan(vendorId, 'dup-plan-name');
    await expect(insertPlan(vendorId, 'dup-plan-name')).rejects.toThrow();
  });

  it('mr_models 重复 (vendor_id, family, version) 三列被拒', async () => {
    const vendorId = await insertVendor('dup-model-vendor');
    const ins = () =>
      pool!.query(
        `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'dupfam', 'v1')`,
        [vendorId],
      );
    await ins();
    await expect(ins()).rejects.toThrow();
  });

  it('junction (mr_plan_models) 重复 (plan_id, model_id) 被拒', async () => {
    const vendorId = await insertVendor('dup-junction-vendor');
    const planId = await insertPlan(vendorId, 'dup-junction-plan');
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'jfam', 'v1') RETURNING id`,
      [vendorId],
    );
    const modelId = rows[0]!.id;
    const link = () =>
      pool!.query(
        `INSERT INTO mr_plan_models (plan_id, model_id, source_url, last_checked, source_confidence)
         VALUES ($1, $2, $3, $4, 'official_doc')`,
        [planId, modelId, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
      );
    await link();
    await expect(link()).rejects.toThrow();
  });

  it('mr_source 重复 (vendor_id, source_url) 被拒', async () => {
    const vendorId = await insertVendor('dup-source-vendor');
    const ins = () =>
      pool!.query(
        `INSERT INTO mr_source (source_url, vendor_id, fetch_strategy)
         VALUES ($1, $2, 'http')`,
        [`https://test.example.invalid/${IT_PREFIX}dup-source`, vendorId],
      );
    await ins();
    await expect(ins()).rejects.toThrow();
  });
});

// ───────────────────────────── 3.7 spec 场景断言 ─────────────────────────────

describe.skipIf(!databaseUrl)('3.7 spec 场景断言', () => {
  it('① 4 桶 category 合成 + Zod 正反（合成插第 4 桶 ide_membership）', async () => {
    // Zod 值集恰好 4 桶。
    expect(mrCategorySchema.options).toEqual([
      'ide_membership',
      'coding_plan',
      'token_plan',
      'enterprise_seat',
    ]);
    expect(mrCategorySchema.safeParse('ide_membership').success).toBe(true);
    expect(mrCategorySchema.safeParse('token_plan').success).toBe(true);
    expect(mrCategorySchema.safeParse('not_a_bucket').success).toBe(false);

    // 合成插入第 4 桶（ide_membership）一行不被拒，与 coding_plan 共存同表。
    const vendorId = await insertVendor('bucket-vendor');
    await insertPlan(vendorId, 'bucket-coding', 'coding_plan');
    await insertPlan(vendorId, 'bucket-ide', 'ide_membership');
    const { rows } = await pool!.query<{ category: string }>(
      `SELECT category FROM mr_plans WHERE vendor_id = $1 ORDER BY category`,
      [vendorId],
    );
    expect(rows.map((r) => r.category)).toEqual(['coding_plan', 'ide_membership']);
  });

  it('② 版本不塌缩（GLM-5.2 ≠ GLM-4.7）+ 无版本哨兵去重', async () => {
    const vendorId = await insertVendor('version-vendor');
    // 同 vendor、family=glm、不同 version → 两条不塌缩。
    await pool!.query(
      `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'glm', '5.2'), ($1, 'glm', '4.7')`,
      [vendorId],
    );
    const { rows } = await pool!.query<{ version: string }>(
      `SELECT version FROM mr_models WHERE vendor_id = $1 AND family = 'glm' ORDER BY version`,
      [vendorId],
    );
    expect(rows.map((r) => r.version)).toEqual(['4.7', '5.2']);

    // 无版本哨兵 '' 第二次插被唯一键拒（不重复入库）。
    const insSentinel = () =>
      pool!.query(
        `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'noversion', '')`,
        [vendorId],
      );
    await insSentinel();
    await expect(insSentinel()).rejects.toThrow();
  });

  it('③ 源 fetch_strategy=browser + 经 mr_plan_sources 定位覆盖 plan 集合', async () => {
    const vendorId = await insertVendor('source-locate-vendor');
    const planLite = await insertPlan(vendorId, 'locate-lite');
    const planPro = await insertPlan(vendorId, 'locate-pro');
    const { rows: src } = await pool!.query<{ id: string }>(
      `INSERT INTO mr_source (source_url, vendor_id, fetch_strategy, content_fingerprint)
       VALUES ($1, $2, 'browser', NULL) RETURNING id`,
      [`https://test.example.invalid/${IT_PREFIX}browser-src`, vendorId],
    );
    const sourceId = src[0]!.id;
    for (const planId of [planLite, planPro]) {
      await pool!.query(
        `INSERT INTO mr_plan_sources (source_id, plan_id) VALUES ($1, $2)`,
        [sourceId, planId],
      );
    }
    // fetch_strategy 确为 browser。
    const { rows: fs } = await pool!.query<{ fetch_strategy: string }>(
      `SELECT fetch_strategy FROM mr_source WHERE id = $1`,
      [sourceId],
    );
    expect(fs[0]!.fetch_strategy).toBe('browser');
    // 经 mr_plan_sources 得该源覆盖的 plan 集合 = {Lite, Pro}。
    const { rows } = await pool!.query<{ plan_id: string }>(
      `SELECT plan_id FROM mr_plan_sources WHERE source_id = $1 ORDER BY plan_id`,
      [sourceId],
    );
    expect(new Set(rows.map((r) => r.plan_id))).toEqual(new Set([planLite, planPro]));
  });

  it('④ junction provenance 独立（official_community 不被冒充为 official_pricing）', async () => {
    const vendorId = await insertVendor('prov-vendor');
    // plan 价格 official_pricing；其一条模型兼容 official_community。
    const { rows: pl } = await pool!.query<{ id: string }>(
      `INSERT INTO mr_plans
         (vendor_id, name, category, current_price, currency, source_url, last_checked, source_confidence)
       VALUES ($1, $2, 'coding_plan', '40.00', 'CNY', $3, $4, 'official_pricing') RETURNING id`,
      [vendorId, `${IT_PREFIX}prov-plan`, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
    );
    const planId = pl[0]!.id;
    const { rows: mr } = await pool!.query<{ id: string }>(
      `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'provfam', 'v1') RETURNING id`,
      [vendorId],
    );
    await pool!.query(
      `INSERT INTO mr_plan_models (plan_id, model_id, source_url, last_checked, source_confidence)
       VALUES ($1, $2, $3, $4, 'official_community')`,
      [planId, mr[0]!.id, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
    );
    const { rows: planRow } = await pool!.query<{ source_confidence: string }>(
      `SELECT source_confidence FROM mr_plans WHERE id = $1`,
      [planId],
    );
    const { rows: pmRow } = await pool!.query<{ source_confidence: string }>(
      `SELECT source_confidence FROM mr_plan_models WHERE plan_id = $1`,
      [planId],
    );
    expect(planRow[0]!.source_confidence).toBe('official_pricing');
    // 兼容行独立保留 official_community，不被 plan 级冒充。
    expect(pmRow[0]!.source_confidence).toBe('official_community');
  });

  it('⑤ needs_login_recheck 半 NULL 占位往返 + Zod refine 拒半 NULL 两负例', async () => {
    const vendorId = await insertVendor('login-vendor');
    // current_price + currency 同 NULL 占位，provenance 齐，不写 price_history。
    const { rows: pl } = await pool!.query<{
      current_price: string | null;
      currency: string | null;
      source_confidence: string;
    }>(
      `INSERT INTO mr_plans
         (vendor_id, name, category, current_price, currency, source_url, last_checked, source_confidence)
       VALUES ($1, $2, 'coding_plan', NULL, NULL, $3, $4, 'needs_login_recheck')
       RETURNING current_price, currency, source_confidence`,
      [vendorId, `${IT_PREFIX}login-plan`, QIANFAN_SOURCE_URL, QIANFAN_LAST_CHECKED],
    );
    expect(pl[0]!.current_price).toBeNull();
    expect(pl[0]!.currency).toBeNull();
    expect(pl[0]!.source_confidence).toBe('needs_login_recheck');

    // Zod refine：同 NULL 合法；两条半 NULL 负例被拒。
    expect(
      mrPlanWriteSchema.safeParse({
        category: 'coding_plan',
        currentPrice: null,
        currency: null,
        sourceConfidence: 'needs_login_recheck',
      }).success,
    ).toBe(true);
    expect(
      mrPlanWriteSchema.safeParse({
        category: 'coding_plan',
        currentPrice: '40.00',
        currency: null,
        sourceConfidence: 'official_doc',
      }).success,
    ).toBe(false); // 有价无币
    expect(
      mrPlanWriteSchema.safeParse({
        category: 'coding_plan',
        currentPrice: null,
        currency: 'CNY',
        sourceConfidence: 'official_doc',
      }).success,
    ).toBe(false); // 有币无价
  });

  it('⑥ 全部 8 个有限值集列 Zod 越界拒 + 合法接受', () => {
    // 各枚举接受合法 / 拒越界（DB 零-CHECK 下 Zod 是唯一合法性闸）。
    const cases: Array<[
      { safeParse: (v: unknown) => { success: boolean } },
      unknown[],
      unknown[],
    ]> = [
      // 5b（add-model-radar-ingestion-freshness task 1.4）全桶扩值往返：credit/fast_pass 现合法。
      [
        mrLimitTypeSchema,
        ['monthly_tokens', 'none', 'credit', 'fast_pass'],
        ['montly_tokens'],
      ],
      [mrSourceConfidenceSchema, ['official_doc', 'needs_login_recheck'], ['rumor']],
      [mrCategorySchema, ['coding_plan'], ['ide_member']],
      // 5b task 1.4：EUR 扩入合法（仍拒小写 / 非 ISO 4217）。
      [mrCurrencySchema, ['CNY', 'USD', 'EUR'], ['cny', 'JPY']],
      [mrReviewFlagStatusSchema, ['pending', 'resolved'], ['open']],
      [mrReviewFlagTargetTypeSchema, ['plan', 'source', 'vendor'], ['model']],
      [mrClientTypeSchema, ['tool', 'protocol'], ['client']],
      [mrFetchStrategySchema, ['http', 'browser', 'manual'], ['playwright']],
    ];
    for (const [schema, valid, invalid] of cases) {
      for (const v of valid) {
        expect(schema.safeParse(v).success, `应接受 ${String(v)}`).toBe(true);
      }
      for (const v of invalid) {
        expect(schema.safeParse(v).success, `应拒 ${String(v)}`).toBe(false);
      }
    }
  });
});

// ───────────────────────────── 3.8 跨厂同名 family 不误合 ─────────────────────────────

describe.skipIf(!databaseUrl)('3.8 两厂商同名 family 不同 vendor 不误合', () => {
  it('vendor A 与 B 各有 family=glm,version=x → 唯一键含 vendor_id，两条不同记录', async () => {
    const vendorA = await insertVendor('crossvendor-a');
    const vendorB = await insertVendor('crossvendor-b');
    for (const vid of [vendorA, vendorB]) {
      await pool!.query(
        `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, 'glm', 'x')`,
        [vid],
      );
    }
    const { rows } = await pool!.query<{ vendor_id: string }>(
      `SELECT vendor_id FROM mr_models WHERE family = 'glm' AND version = 'x'
         AND vendor_id IN ($1, $2) ORDER BY vendor_id`,
      [vendorA, vendorB],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.vendor_id))).toEqual(new Set([vendorA, vendorB]));
  });
});

// ───────────────────────────── 4.2 fixture 完整录入读回 ─────────────────────────────

describe.skipIf(!databaseUrl)('4.2 千帆 Coding Plan fixture 完整录入读回（单厂单桶无损）', () => {
  it('厂商/套餐/模型兼容/工具协议兼容/限额/价格历史/provenance 逐项一致', async () => {
    // 1) 厂商身份行。
    const { rows: ven } = await pool!.query<{ id: string; name: string }>(
      `INSERT INTO mr_vendors (normalized_name, name) VALUES ($1, $2) RETURNING id, name`,
      [qianfanVendor.normalizedName, qianfanVendor.name],
    );
    const vendorId = ven[0]!.id;
    expect(ven[0]!.name).toBe('百度千帆');

    // 2) 模型身份行（带版本，family 已小写归一）。
    const modelIdByKey = new Map<string, string>();
    for (const m of qianfanModels) {
      const { rows } = await pool!.query<{ id: string }>(
        `INSERT INTO mr_models (vendor_id, family, version) VALUES ($1, $2, $3) RETURNING id`,
        [vendorId, m.family, m.version],
      );
      modelIdByKey.set(`${m.family}/${m.version}`, rows[0]!.id);
    }
    expect(modelIdByKey.size).toBe(5);

    // 3) 套餐 + 模型兼容 + 工具协议兼容 + 限额。
    const planIdByName = new Map<string, string>();
    for (const plan of qianfanPlans) {
      const { rows: pl } = await pool!.query<{
        id: string;
        category: string;
        current_price: string;
        currency: string;
        source_confidence: string;
      }>(
        `INSERT INTO mr_plans
           (vendor_id, name, category, current_price, currency, source_url, last_checked, source_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, category, current_price, currency, source_confidence`,
        [
          vendorId,
          plan.name,
          plan.category,
          plan.currentPrice,
          plan.currency,
          plan.sourceUrl,
          QIANFAN_LAST_CHECKED,
          plan.sourceConfidence,
        ],
      );
      const planId = pl[0]!.id;
      planIdByName.set(plan.name, planId);
      // plan 字段逐项读回一致（numeric 字符串归一）。
      expect(pl[0]!.category).toBe(plan.category);
      expect(pl[0]!.current_price).toBe(plan.currentPrice);
      expect(pl[0]!.currency).toBe(plan.currency);
      expect(pl[0]!.source_confidence).toBe(plan.sourceConfidence);

      for (const mk of plan.modelKeys) {
        await pool!.query(
          `INSERT INTO mr_plan_models (plan_id, model_id, source_url, last_checked, source_confidence)
           VALUES ($1, $2, $3, $4, 'official_doc')`,
          [planId, modelIdByKey.get(`${mk.family}/${mk.version}`), plan.sourceUrl, QIANFAN_LAST_CHECKED],
        );
      }
      for (const ck of plan.clientKeys) {
        await pool!.query(
          `INSERT INTO mr_plan_clients (plan_id, client_type, client_id, source_url, last_checked, source_confidence)
           VALUES ($1, $2, $3, $4, $5, 'official_doc')`,
          [planId, ck.clientType, ck.clientId, plan.sourceUrl, QIANFAN_LAST_CHECKED],
        );
      }
      for (const lim of plan.limits) {
        await pool!.query(
          `INSERT INTO mr_plan_limits
             (plan_id, limit_type, value, "window", source_url, last_checked, source_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, 'official_doc')`,
          [planId, lim.limitType, lim.value, lim.window, plan.sourceUrl, QIANFAN_LAST_CHECKED],
        );
      }
    }

    // 4) 价格历史（Pro：¥150 → ¥200）。
    for (const h of qianfanPriceHistory) {
      await pool!.query(
        `INSERT INTO mr_price_history
           (plan_id, old_value, new_value, currency, changed_at, source_url, source_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          planIdByName.get(h.planName),
          h.oldValue,
          h.newValue,
          h.currency,
          h.changedAt,
          h.sourceUrl,
          h.sourceConfidence,
        ],
      );
    }

    // 5) 源定位边（browser 源覆盖 Lite + Pro）。
    const { rows: src } = await pool!.query<{ id: string; fetch_strategy: string }>(
      `INSERT INTO mr_source (source_url, vendor_id, fetch_strategy, content_fingerprint)
       VALUES ($1, $2, $3, $4) RETURNING id, fetch_strategy`,
      [qianfanSource.sourceUrl, vendorId, qianfanSource.fetchStrategy, qianfanSource.contentFingerprint],
    );
    const sourceId = src[0]!.id;
    expect(src[0]!.fetch_strategy).toBe('browser');
    for (const planId of planIdByName.values()) {
      await pool!.query(
        `INSERT INTO mr_plan_sources (source_id, plan_id) VALUES ($1, $2)`,
        [sourceId, planId],
      );
    }

    // ── 读回比对 ──
    // Pro 套餐含全部 5 个模型兼容、2 个工具、2 条限额。
    const proId = planIdByName.get('mr-it-qianfan/Coding Plan Pro')!;
    const { rows: proModels } = await pool!.query<{ n: string }>(
      `SELECT count(*) AS n FROM mr_plan_models WHERE plan_id = $1`,
      [proId],
    );
    expect(Number(proModels[0]!.n)).toBe(5);
    const { rows: proClients } = await pool!.query<{ client_id: string }>(
      `SELECT client_id FROM mr_plan_clients WHERE plan_id = $1 ORDER BY client_id`,
      [proId],
    );
    expect(proClients.map((r) => r.client_id)).toEqual(['Claude Code', 'Qwen Code']);
    const { rows: proLimits } = await pool!.query<{
      limit_type: string;
      value: string;
      window: string;
    }>(
      `SELECT limit_type, value, "window" FROM mr_plan_limits WHERE plan_id = $1 ORDER BY limit_type`,
      [proId],
    );
    expect(proLimits).toHaveLength(2);
    const limitByType = new Map(proLimits.map((r) => [r.limit_type, r]));
    expect(limitByType.get('monthly_tokens')!.value).toBe('9000');
    expect(limitByType.get('rolling_5h_requests')!.value).toBe('18000');

    // 价格历史读回（旧值 ¥150 留痕，currency / provenance 一致）。
    const { rows: hist } = await pool!.query<{
      old_value: string;
      new_value: string;
      currency: string;
      source_confidence: string;
    }>(
      `SELECT old_value, new_value, currency, source_confidence
       FROM mr_price_history WHERE plan_id = $1`,
      [proId],
    );
    expect(hist).toHaveLength(1);
    expect(hist[0]!.old_value).toBe('150.00');
    expect(hist[0]!.new_value).toBe('200.00');
    expect(hist[0]!.currency).toBe('CNY');
    expect(hist[0]!.source_confidence).toBe('official_doc');

    // 源覆盖 plan 集合 = {Lite, Pro}。
    const { rows: covered } = await pool!.query<{ plan_id: string }>(
      `SELECT plan_id FROM mr_plan_sources WHERE source_id = $1`,
      [sourceId],
    );
    expect(new Set(covered.map((r) => r.plan_id))).toEqual(
      new Set(planIdByName.values()),
    );

    // 断言事实表 provenance 逐项读回一致：4 张断言事实表各读回 source_url + last_checked
    // + source_confidence；mr_price_history 例外读回 source_url + source_confidence + changed_at
    // （无 last_checked）。spec.md needs:11「各断言事实表 provenance 三字段均逐项读回一致」。
    const proPlan = qianfanPlans.find((p) => p.name === 'mr-it-qianfan/Coding Plan Pro')!;
    // mr_plans：用 plan.sourceConfidence/sourceUrl + QIANFAN_LAST_CHECKED。
    const { rows: planProv } = await pool!.query<{
      source_url: string;
      source_confidence: string;
      last_checked: Date;
    }>(
      `SELECT source_url, source_confidence, last_checked FROM mr_plans WHERE id = $1`,
      [proId],
    );
    expect(planProv[0]!.source_url).toBe(proPlan.sourceUrl);
    expect(planProv[0]!.source_confidence).toBe(proPlan.sourceConfidence);
    expect(new Date(planProv[0]!.last_checked).toISOString()).toBe(QIANFAN_LAST_CHECKED);
    // mr_plan_models / mr_plan_clients / mr_plan_limits：插入时均 'official_doc'
    // + QIANFAN_SOURCE_URL + QIANFAN_LAST_CHECKED。
    for (const table of ['mr_plan_models', 'mr_plan_clients', 'mr_plan_limits']) {
      const { rows: prov } = await pool!.query<{
        source_url: string;
        source_confidence: string;
        last_checked: Date;
      }>(
        `SELECT source_url, source_confidence, last_checked FROM ${table} WHERE plan_id = $1 LIMIT 1`,
        [proId],
      );
      expect(prov[0]!.source_url, `${table} source_url`).toBe(QIANFAN_SOURCE_URL);
      expect(prov[0]!.source_confidence, `${table} source_confidence`).toBe('official_doc');
      expect(
        new Date(prov[0]!.last_checked).toISOString(),
        `${table} last_checked`,
      ).toBe(QIANFAN_LAST_CHECKED);
    }
    // mr_price_history 例外：读回 source_url + source_confidence + changed_at（无 last_checked）。
    const proHistory = qianfanPriceHistory.find(
      (h) => h.planName === 'mr-it-qianfan/Coding Plan Pro',
    )!;
    const { rows: histProv } = await pool!.query<{
      source_url: string;
      source_confidence: string;
      changed_at: Date;
    }>(
      `SELECT source_url, source_confidence, changed_at FROM mr_price_history WHERE plan_id = $1 LIMIT 1`,
      [proId],
    );
    expect(histProv[0]!.source_url).toBe(proHistory.sourceUrl);
    expect(histProv[0]!.source_confidence).toBe(proHistory.sourceConfidence);
    expect(new Date(histProv[0]!.changed_at).toISOString()).toBe(proHistory.changedAt);
  });
});
