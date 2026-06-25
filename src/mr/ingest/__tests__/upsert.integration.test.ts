/**
 * 录入 Zod 闸 + identity/fact 写契约集成测试（task 7.1，**需本地 Postgres**，design D1/D2/D3）。
 *
 * 覆盖 spec「录入经 Zod 闸」/「ingest 区分 identity 与 fact 写」：
 * ① 非录入路径写枚举列也过 Zod（含 `mr_plan_models` + flag 写）：非法值发 SQL 前被拒、不落库；
 * ② 全桶往返：`credit`/`fast_pass`（limit_type）、`EUR`（currency）经 upsert 真落库；
 * ③ family `GLM`/`glm` 同 vendor/version 命中同行不分裂（design D3）；
 * ④ 同 (vendor,name) 异 category 打 conflict flag、不静默 no-op（唯一键不含 category）；
 * ⑤ identity 幂等（重录同 vendor/model = exists 不报错）；fact 全同字段 = noop。
 *
 * 不触网 / 不触 LLM；缺 DATABASE_URL 时自动跳过。唯一前缀隔离 + afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const {
  upsertVendor,
  upsertModel,
  upsertPlan,
  upsertPlanLimit,
  upsertPlanModel,
  upsertSource,
} = await import('../upsert.js');

const PREFIX = 'mr-upsert-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function cleanup() {
  if (!db) return;
  // 子表先删（无 FK 但保持有序）。按前缀隔离自己造的行。
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.targetId, `${PREFIX}%`));
  await db.delete(schema.mrPriceHistory).where(like(schema.mrPriceHistory.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanModels).where(like(schema.mrPlanModels.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanLimits).where(like(schema.mrPlanLimits.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrModels).where(like(schema.mrModels.family, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describeIfDb('7.1 录入 Zod 闸 + identity/fact 写契约', () => {
  it('identity：upsertVendor 幂等（重录 = exists）', async () => {
    const n = `${PREFIX}vendor-a`;
    const a = await upsertVendor(db!, { normalizedName: n, name: 'Vendor A' });
    expect(a.outcome).toBe('inserted');
    const b = await upsertVendor(db!, { normalizedName: n, name: 'Vendor A' });
    expect(b.outcome).toBe('exists');
    expect(b.id).toBe(a.id);
  });

  it('design D3：family GLM/glm 同 vendor/version 命中同行不分裂', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-glm`,
      name: 'GLM Vendor',
    });
    const m1 = await upsertModel(db!, {
      vendorId: v.id,
      family: `${PREFIX}GLM`,
      version: '5.2',
    });
    const m2 = await upsertModel(db!, {
      vendorId: v.id,
      family: `${PREFIX}glm`, // 仅大小写不同
      version: '5.2',
    });
    expect(m1.outcome).toBe('inserted');
    expect(m2.outcome).toBe('exists'); // 归一后命中同行，不分裂
    expect(m2.id).toBe(m1.id);

    // 库里 family 已小写归一存储。
    const rows = await db!
      .select()
      .from(schema.mrModels)
      .where(eq(schema.mrModels.id, m1.id));
    expect(rows[0]!.family).toBe(`${PREFIX}glm`.toLowerCase());
  });

  it('全桶往返：credit/fast_pass limit + EUR plan 真落库', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-buckets`,
      name: 'Bucket Vendor',
    });
    const plan = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}Token Plan Pro`,
      category: 'token_plan',
      currentPrice: '20.00',
      currency: 'EUR',
      sourceUrl: `${PREFIX}src-token`,
      sourceConfidence: 'official_pricing',
    });
    expect(plan.outcome).toBe('inserted');
    const planId = (plan as { id: string }).id;

    for (const limitType of ['credit', 'fast_pass'] as const) {
      const lim = await upsertPlanLimit(db!, {
        planId,
        limitType,
        value: '1000',
        window: 'month',
        sourceUrl: `${PREFIX}src-${limitType}`,
        sourceConfidence: 'official_pricing',
      });
      expect(lim.outcome).toBe('inserted');
    }
    const limits = await db!
      .select()
      .from(schema.mrPlanLimits)
      .where(eq(schema.mrPlanLimits.planId, planId));
    expect(limits.map((l) => l.limitType).sort()).toEqual(['credit', 'fast_pass']);

    const planRow = await db!
      .select()
      .from(schema.mrPlans)
      .where(eq(schema.mrPlans.id, planId));
    expect(planRow[0]!.currency).toBe('EUR');
  });

  it('同 (vendor,name) 异 category 打 conflict flag、不静默 no-op', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-cat`,
      name: 'Cat Vendor',
    });
    const name = `${PREFIX}Same Name Plan`;
    const a = await upsertPlan(db!, {
      vendorId: v.id,
      name,
      category: 'coding_plan',
      currentPrice: '30.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-cat`,
      sourceConfidence: 'official_pricing',
    });
    expect(a.outcome).toBe('inserted');
    const planId = (a as { id: string }).id;

    // 重录同 (vendor,name)，category 异（价/provenance 全同）→ 必须打 conflict，不当幂等吞掉。
    const b = await upsertPlan(db!, {
      vendorId: v.id,
      name,
      category: 'token_plan', // 异
      currentPrice: '30.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-cat`,
      sourceConfidence: 'official_pricing',
    });
    expect(b.outcome).toBe('conflict');
    expect((b as { field: string }).field).toBe('category');

    // 库里 category 未被盲覆盖（仍是首录的 coding_plan）。
    const planRow = await db!
      .select()
      .from(schema.mrPlans)
      .where(eq(schema.mrPlans.id, planId));
    expect(planRow[0]!.category).toBe('coding_plan');

    // 打了 plan 级 flag。
    const flags = await db!
      .select()
      .from(schema.mrReviewFlag)
      .where(
        and(
          eq(schema.mrReviewFlag.targetType, 'plan'),
          eq(schema.mrReviewFlag.targetId, planId),
        ),
      );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.status).toBe('pending');
  });

  it('fact 全同字段 = noop（幂等）', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-noop`,
      name: 'Noop Vendor',
    });
    const args = {
      vendorId: v.id,
      name: `${PREFIX}Noop Plan`,
      category: 'ide_membership' as const,
      currentPrice: null,
      currency: null,
      sourceUrl: `${PREFIX}src-noop`,
      sourceConfidence: 'needs_login_recheck' as const,
    };
    const a = await upsertPlan(db!, args);
    expect(a.outcome).toBe('inserted');
    const b = await upsertPlan(db!, args);
    expect(b.outcome).toBe('noop');
  });

  it('m6 price-delegated：异价重录 → 委托改价、history 多一行（old_value=改前 current）', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-price-deleg`,
      name: 'Price Deleg Vendor',
    });
    const name = `${PREFIX}Price Deleg Plan`;
    const a = await upsertPlan(db!, {
      vendorId: v.id,
      name,
      category: 'coding_plan',
      currentPrice: '30.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-price-deleg`,
      sourceConfidence: 'official_pricing',
    });
    expect(a.outcome).toBe('inserted');
    const planId = (a as { id: string }).id;

    // 同 (vendor,name)、异价 45 → 委托 recordPriceChange（同事务原子）。
    const b = await upsertPlan(db!, {
      vendorId: v.id,
      name,
      category: 'coding_plan',
      currentPrice: '45.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-price-deleg`,
      sourceConfidence: 'official_pricing',
    });
    expect(b.outcome).toBe('price-delegated');

    // history 多一行：new_value=45、old_value=改前 current 30。
    const hist = await db!
      .select()
      .from(schema.mrPriceHistory)
      .where(eq(schema.mrPriceHistory.planId, planId));
    expect(hist).toHaveLength(1);
    expect(Number(hist[0]!.newValue)).toBe(45);
    expect(Number(hist[0]!.oldValue)).toBe(30);

    // current 已被授权入口刷为 45。
    const planRow = await db!
      .select()
      .from(schema.mrPlans)
      .where(eq(schema.mrPlans.id, planId));
    expect(Number(planRow[0]!.currentPrice)).toBe(45);
  });

  it('非录入路径写 mr_plan_models 非法 source_confidence → 发 SQL 前被 Zod 拒', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-zod`,
      name: 'Zod Vendor',
    });
    const plan = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}Zod Plan`,
      category: 'coding_plan',
      currentPrice: '10.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-zod`,
      sourceConfidence: 'official_pricing',
    });
    const planId = (plan as { id: string }).id;
    await expect(
      upsertPlanModel(db!, {
        planId,
        modelId: 'some-model',
        sourceUrl: `${PREFIX}src-zod-pm`,
        sourceConfidence: 'guess', // 非法枚举
      }),
    ).rejects.toThrow();
    // 不落库。
    const pm = await db!
      .select()
      .from(schema.mrPlanModels)
      .where(eq(schema.mrPlanModels.planId, planId));
    expect(pm).toHaveLength(0);
  });

  it('M6 录入白名单闸：非白名单/私网/file:// 的 source_url → 抛错不落库', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-srcgate`,
      name: 'SrcGate Vendor',
    });
    for (const badUrl of [
      'https://evil.example.com/pricing', // host ∉ 白名单
      'http://169.254.169.254/latest/meta-data', // 私网/元数据 IP
      'file:///etc/passwd', // 非 http(s) scheme
    ]) {
      await expect(
        upsertSource(db!, {
          vendorId: v.id,
          sourceUrl: badUrl,
          fetchStrategy: 'http',
        }),
      ).rejects.toThrow();
    }
    // 一条都没落库。
    const rows = await db!
      .select()
      .from(schema.mrSource)
      .where(eq(schema.mrSource.vendorId, v.id));
    expect(rows).toHaveLength(0);
  });

  it('M6 录入闸豁免 manual：非白名单 URL + fetchStrategy=manual → 成功录入不抛（design D10）', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-manual-exempt`,
      name: 'Manual Exempt Vendor',
    });
    // manual 源不发请求、豁免白名单闸：非白名单 URL（带前缀确保 cleanup 命中）也应成功录入。
    const r = await upsertSource(db!, {
      vendorId: v.id,
      sourceUrl: `${PREFIX}https://not-allowed.example`,
      fetchStrategy: 'manual',
    });
    expect(r.outcome).toBe('inserted');
    const rows = await db!
      .select()
      .from(schema.mrSource)
      .where(eq(schema.mrSource.vendorId, v.id));
    expect(rows).toHaveLength(1);
  });

  it('非法 category 发 SQL 前被 Zod 拒（不落库）', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-badcat`,
      name: 'BadCat Vendor',
    });
    await expect(
      upsertPlan(db!, {
        vendorId: v.id,
        name: `${PREFIX}BadCat Plan`,
        category: 'free_tier', // 非法桶
        currentPrice: null,
        currency: null,
        sourceUrl: `${PREFIX}src-badcat`,
        sourceConfidence: 'official_pricing',
      }),
    ).rejects.toThrow();
    const rows = await db!
      .select()
      .from(schema.mrPlans)
      .where(eq(schema.mrPlans.vendorId, v.id));
    expect(rows).toHaveLength(0);
  });
});
