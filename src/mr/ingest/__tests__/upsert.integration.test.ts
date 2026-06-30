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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

// upsertPlan post-commit 经 runSnapshotRebuild 调真 publisher（连 env.REDIS_URL）。mock 成 no-op，
// 守「测试绝不连真 Redis」红线、并免 Redis-down 时每次 publish 阻塞 ~1s（仿 cache.test.ts）。
vi.mock('../../snapshot/invalidation.js', () => ({
  publishSnapshotInvalidation: vi.fn(async () => {}),
  createSnapshotInvalidationSubscriber: vi.fn(() => ({ quit: vi.fn(async () => {}) })),
  SNAPSHOT_INVALIDATION_CHANNEL: 'mr:snapshot:invalidate',
}));

const {
  setPlanAvailability,
  upsertVendor,
  upsertModel,
  upsertPlan,
  upsertPlanLimit,
  upsertPlanModel,
  upsertPlanPeriodPrice,
  upsertSource,
} = await import('../upsert.js');

const PREFIX = 'mr-upsert-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

async function cleanup() {
  if (!db) return;
  // relation-based 清理：flag/限额/兼容等的 targetId/planId 是 generated UUID（非 PREFIX），
  // 按 sourceUrl/targetId 的 PREFIX like 漏删。改为先查 PREFIX 的 vendors → 其 plans/sources，
  // 再按这些 id 删 dependent 行，最后删主行（无 FK 但保持有序）。
  const vendors = await db
    .select({ id: schema.mrVendors.id })
    .from(schema.mrVendors)
    .where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
  const vendorIds = vendors.map((v) => v.id);
  if (vendorIds.length > 0) {
    const plans = await db
      .select({ id: schema.mrPlans.id })
      .from(schema.mrPlans)
      .where(inArray(schema.mrPlans.vendorId, vendorIds));
    const planIds = plans.map((p) => p.id);
    const sources = await db
      .select({ id: schema.mrSource.id })
      .from(schema.mrSource)
      .where(inArray(schema.mrSource.vendorId, vendorIds));
    const sourceIds = sources.map((s) => s.id);

    // flag 多态引 plan/source/vendor 三身份 id（targetId = generated id，非 PREFIX）。
    const flagIds = [...planIds, ...sourceIds, ...vendorIds];
    if (flagIds.length > 0) {
      await db
        .delete(schema.mrReviewFlag)
        .where(inArray(schema.mrReviewFlag.targetId, flagIds));
    }
    if (planIds.length > 0) {
      await db.delete(schema.mrPriceHistory).where(inArray(schema.mrPriceHistory.planId, planIds));
      await db.delete(schema.mrPlanPrices).where(inArray(schema.mrPlanPrices.planId, planIds));
      await db.delete(schema.mrPlanModels).where(inArray(schema.mrPlanModels.planId, planIds));
      await db.delete(schema.mrPlanLimits).where(inArray(schema.mrPlanLimits.planId, planIds));
      await db.delete(schema.mrPlanClients).where(inArray(schema.mrPlanClients.planId, planIds));
      await db.delete(schema.mrPlanSources).where(inArray(schema.mrPlanSources.planId, planIds));
    }
    await db.delete(schema.mrPlans).where(inArray(schema.mrPlans.vendorId, vendorIds));
    await db.delete(schema.mrSource).where(inArray(schema.mrSource.vendorId, vendorIds));
    await db.delete(schema.mrModels).where(inArray(schema.mrModels.vendorId, vendorIds));
    await db.delete(schema.mrVendors).where(inArray(schema.mrVendors.id, vendorIds));
  }
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

  it('同 (vendor,name) 异 availability 打 conflict flag、不盲覆盖；授权 setter 可显式改 lifecycle', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-availability`,
      name: 'Availability Vendor',
    });
    const name = `${PREFIX}Availability Plan`;
    const a = await upsertPlan(db!, {
      vendorId: v.id,
      name,
      category: 'coding_plan',
      availability: 'on_sale',
      currentPrice: '49.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-avail`,
      sourceConfidence: 'official_pricing',
    });
    expect(a.outcome).toBe('inserted');
    const planId = (a as { id: string }).id;

    const b = await upsertPlan(db!, {
      vendorId: v.id,
      name,
      category: 'coding_plan',
      availability: 'discontinued',
      currentPrice: '49.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-avail`,
      sourceConfidence: 'official_pricing',
    });
    expect(b.outcome).toBe('conflict');
    expect((b as { field: string }).field).toBe('availability');
    const flags = await db!
      .select()
      .from(schema.mrReviewFlag)
      .where(eq(schema.mrReviewFlag.targetId, planId));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.status).toBe('pending');
    expect(flags[0]!.reason).toContain('availability');

    let planRows = await db!
      .select()
      .from(schema.mrPlans)
      .where(eq(schema.mrPlans.id, planId));
    expect(planRows[0]!.availability).toBe('on_sale');

    const set = await setPlanAvailability(db!, planId, 'discontinued');
    expect(set.outcome).toBe('updated');
    planRows = await db!
      .select()
      .from(schema.mrPlans)
      .where(eq(schema.mrPlans.id, planId));
    expect(planRows[0]!.availability).toBe('discontinued');
  });

  it('upsertPlanPeriodPrice：拒 monthly，同价刷新 provenance/last_checked，异价 conflict 不盲覆盖', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-period-price`,
      name: 'Period Price Vendor',
    });
    const plan = await upsertPlan(db!, {
      vendorId: v.id,
      name: `${PREFIX}Period Price Plan`,
      category: 'coding_plan',
      availability: 'on_sale',
      currentPrice: '49.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-period-month`,
      sourceConfidence: 'official_pricing',
    });
    const planId = (plan as { id: string }).id;

    await expect(
      upsertPlanPeriodPrice(db!, {
        planId,
        billingPeriod: 'monthly',
        price: '49.00',
        currency: 'CNY',
        sourceUrl: `${PREFIX}src-period`,
        sourceConfidence: 'official_pricing',
      }),
    ).rejects.toThrow();

    const inserted = await upsertPlanPeriodPrice(db!, {
      planId,
      billingPeriod: 'annual',
      price: '468.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-period-a`,
      sourceConfidence: 'official_pricing',
      lastChecked: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(inserted.outcome).toBe('inserted');

    const refreshed = await upsertPlanPeriodPrice(db!, {
      planId,
      billingPeriod: 'annual',
      price: '468.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-period-b`,
      sourceConfidence: 'official_doc',
      lastChecked: new Date('2026-06-02T00:00:00.000Z'),
    });
    expect(refreshed.outcome).toBe('refreshed');
    let rows = await db!
      .select()
      .from(schema.mrPlanPrices)
      .where(eq(schema.mrPlanPrices.planId, planId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceUrl).toBe(`${PREFIX}src-period-b`);
    expect(rows[0]!.sourceConfidence).toBe('official_doc');
    expect(rows[0]!.lastChecked.toISOString()).toBe('2026-06-02T00:00:00.000Z');

    const conflict = await upsertPlanPeriodPrice(db!, {
      planId,
      billingPeriod: 'annual',
      price: '500.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-period-c`,
      sourceConfidence: 'official_pricing',
    });
    expect(conflict.outcome).toBe('conflict');
    expect((conflict as { field: string }).field).toBe('price');
    rows = await db!
      .select()
      .from(schema.mrPlanPrices)
      .where(eq(schema.mrPlanPrices.planId, planId));
    expect(Number(rows[0]!.price)).toBe(468);
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
    // manual 源不发请求、豁免白名单闸：非白名单 URL 也应成功录入（cleanup 已改 relation-based，不再需 PREFIX 字面）。
    const r = await upsertSource(db!, {
      vendorId: v.id,
      sourceUrl: 'https://not-allowed.example',
      fetchStrategy: 'manual',
    });
    expect(r.outcome).toBe('inserted');
    const rows = await db!
      .select()
      .from(schema.mrSource)
      .where(eq(schema.mrSource.vendorId, v.id));
    expect(rows).toHaveLength(1);
  });

  it('upsertSource：同 (vendor,source_url) 改 fetch_strategy → 更新生效（定位元数据非事实）', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-fetch-drift`,
      name: 'Fetch Drift Vendor',
    });
    // 用白名单域名 URL，使 http/browser 也过 SSRF 闸（ingest 侧仅查 scheme/allowlist/字面 IP）。
    const url = 'https://openai.com/pricing';
    const a = await upsertSource(db!, {
      vendorId: v.id,
      sourceUrl: url,
      fetchStrategy: 'http',
    });
    expect(a.outcome).toBe('inserted');

    // 同 (vendor,source_url) 改 http→browser → 更新（旧 lane 不长存）。
    const b = await upsertSource(db!, {
      vendorId: v.id,
      sourceUrl: url,
      fetchStrategy: 'browser',
    });
    expect(b.outcome).toBe('updated');
    expect((b as { field: string }).field).toBe('fetch_strategy');
    expect((b as { id: string }).id).toBe((a as { id: string }).id);

    // 库里 fetch_strategy 已更正为 browser。
    const rows = await db!
      .select()
      .from(schema.mrSource)
      .where(eq(schema.mrSource.id, (a as { id: string }).id));
    expect(rows[0]!.fetchStrategy).toBe('browser');

    // 相同 fetch_strategy 重录 → exists（幂等，不更新）。
    const c = await upsertSource(db!, {
      vendorId: v.id,
      sourceUrl: url,
      fetchStrategy: 'browser',
    });
    expect(c.outcome).toBe('exists');
  });

  it('upsertModel：纯空白 family → Zod 校验拒（不落库畸形身份键）', async () => {
    const v = await upsertVendor(db!, {
      normalizedName: `${PREFIX}vendor-blank-family`,
      name: 'Blank Family Vendor',
    });
    await expect(
      upsertModel(db!, { vendorId: v.id, family: '   ', version: '1.0' }),
    ).rejects.toThrow();
    const rows = await db!
      .select()
      .from(schema.mrModels)
      .where(eq(schema.mrModels.vendorId, v.id));
    expect(rows).toHaveLength(0);
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
