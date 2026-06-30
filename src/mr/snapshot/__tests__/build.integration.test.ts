/**
 * 只读快照构建器集成测试（task 2.5，**需本地 Postgres**，design D1/D2/D8）。
 *
 * 覆盖 spec「只读快照从 mr_* 子集构建并校验」「快照聚合源与厂商待复核及陈旧状态」：
 * ① 完整关系 + provenance（vendor/models/clients/limits/sources 去规范化 + 每事实 provenance + priceStatus）；
 * ② source flag / vendor flag 传导到 plan.reviewStatus；
 * ③ child 行陈旧 + 从未抓 browser 源（last_checked NULL）判 freshness.stale，全新鲜不误判；
 * ④ unknown price 无损读回（占位 NULL 与非官方 confidence 带价均判 unknown，价格原值保留）；
 * ⑤ 并发写中途提交不产生撕裂快照（未提交的 plan+limit 原子不可见，提交后原子可见）；
 * ⑥ schema 校验失败 fail-closed（非法枚举 → 抛错、不返回坏快照）。
 *
 * 不触网/不触 LLM；缺 DATABASE_URL 时自动跳过。用唯一前缀隔离，afterAll 清理。
 * 注意：builder 做全局读（读全库 mr_*），断言一律按自造行的 id 定位，不假设快照只含本套件行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { buildModelRadarSnapshot } = await import('../build.js');

const PREFIX = 'mr-snapshot-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

const OLD = new Date('2000-01-01T00:00:00Z');
const NOW = new Date();
// build.ts env-clean 后 thresholdDays 必填、无默认；显式喂 = env.MR_STALENESS_THRESHOLD_DAYS 默认（与排程同口径），保行为等价。
const THRESHOLD_DAYS = 30;

async function cleanup() {
  if (!db) return;
  await db.delete(schema.mrReviewFlag).where(like(schema.mrReviewFlag.reason, `${PREFIX}%`));
  const srcIds = (
    await db.select({ id: schema.mrSource.id }).from(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`))
  ).map((r) => r.id);
  if (srcIds.length) {
    await db.delete(schema.mrPlanSources).where(inArray(schema.mrPlanSources.sourceId, srcIds));
  }
  await db.delete(schema.mrPlanPrices).where(like(schema.mrPlanPrices.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanModels).where(like(schema.mrPlanModels.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanClients).where(like(schema.mrPlanClients.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlanLimits).where(like(schema.mrPlanLimits.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrPlans).where(like(schema.mrPlans.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrModels).where(like(schema.mrModels.family, `${PREFIX}%`));
  await db.delete(schema.mrSource).where(like(schema.mrSource.sourceUrl, `${PREFIX}%`));
  await db.delete(schema.mrVendors).where(like(schema.mrVendors.normalizedName, `${PREFIX}%`));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

async function makeVendor(suffix: string): Promise<string> {
  const [v] = await db!
    .insert(schema.mrVendors)
    .values({ normalizedName: `${PREFIX}v-${suffix}`, name: `Vendor ${suffix}` })
    .returning();
  return v!.id;
}

interface PlanOpts {
  currentPrice?: string | null;
  currency?: string | null;
  sourceConfidence?: string;
  lastChecked?: Date;
}

async function makePlan(vendorId: string, suffix: string, opts: PlanOpts = {}): Promise<string> {
  const [plan] = await db!
    .insert(schema.mrPlans)
    .values({
      vendorId,
      name: `${PREFIX}plan-${suffix}`,
      category: 'coding_plan',
      currentPrice: opts.currentPrice === undefined ? '20.00' : opts.currentPrice,
      currency: opts.currency === undefined ? 'USD' : opts.currency,
      sourceUrl: `${PREFIX}src-${suffix}`,
      lastChecked: opts.lastChecked ?? NOW,
      sourceConfidence: opts.sourceConfidence ?? 'official_pricing',
    })
    .returning();
  return plan!.id;
}

/** 取快照中指定 id 的 plan（builder 全局读，按 id 定位本套件行）。 */
async function snapPlan(planId: string) {
  const snap = await buildModelRadarSnapshot(db!, NOW, THRESHOLD_DAYS);
  return snap.plans.find((p) => p.id === planId);
}

describeIfDb('2.5 快照构建', () => {
  it('完整关系 + provenance + priceStatus 去规范化读回', async () => {
    const vendorId = await makeVendor('full');
    const planId = await makePlan(vendorId, 'full', {
      currentPrice: '20.00',
      currency: 'USD',
      sourceConfidence: 'official_pricing',
    });
    const [model] = await db!
      .insert(schema.mrModels)
      .values({ vendorId, family: `${PREFIX}fam-full`, version: '4.6' })
      .returning();
    await db!.insert(schema.mrPlanModels).values({
      planId,
      modelId: model!.id,
      sourceUrl: `${PREFIX}src-full`,
      lastChecked: NOW,
      sourceConfidence: 'official_community',
    });
    await db!.insert(schema.mrPlanClients).values({
      planId,
      clientType: 'tool',
      clientId: 'claude-code',
      sourceUrl: `${PREFIX}src-full`,
      lastChecked: NOW,
      sourceConfidence: 'official_doc',
    });
    await db!.insert(schema.mrPlanLimits).values({
      planId,
      limitType: 'monthly_tokens',
      value: '1000000',
      window: 'month',
      sourceUrl: `${PREFIX}src-full`,
      lastChecked: NOW,
      sourceConfidence: 'official_pricing',
    });
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-full`,
        vendorId,
        fetchStrategy: 'http',
        lastChecked: NOW,
      })
      .returning();
    await db!.insert(schema.mrPlanSources).values({ planId, sourceId: src!.id });

    const plan = await snapPlan(planId);
    expect(plan).toBeDefined();
    expect(plan!.vendorName).toBe('Vendor full');
    expect(plan!.priceStatus).toBe('known');
    expect(plan!.currentPrice).toBe('20.00');
    expect(plan!.currency).toBe('USD');
    expect(plan!.availability).toBe('unknown');
    expect(plan!.provenance.sourceConfidence).toBe('official_pricing');
    expect(plan!.provenance.sourceUrl).toBe(`${PREFIX}src-full`);
    // 去规范化关系
    const nowDate = NOW.toISOString().slice(0, 10); // 全行 lastChecked=NOW → 同 UTC 日 date
    expect(plan!.models).toEqual([
      {
        modelId: model!.id,
        family: `${PREFIX}fam-full`,
        version: '4.6',
        provenance: {
          sourceUrl: `${PREFIX}src-full`,
          sourceConfidence: 'official_community',
          lastCheckedDate: nowDate,
        },
      },
    ]);
    expect(plan!.clients).toHaveLength(1);
    expect(plan!.clients[0]!.clientId).toBe('claude-code');
    expect(plan!.clients[0]!.provenance.lastCheckedDate).toBe(nowDate);
    expect(plan!.limits[0]!.value).toBe('1000000');
    expect(plan!.limits[0]!.window).toBe('month');
    expect(plan!.limits[0]!.provenance.lastCheckedDate).toBe(nowDate);
    expect(plan!.periodPrices).toEqual([]);
    // 价格事实 date = trunc(plan.last_checked)
    expect(plan!.provenance.lastCheckedDate).toBe(nowDate);
    expect(plan!.sources).toEqual([
      { sourceUrl: `${PREFIX}src-full`, fetchStrategy: 'http', lastCheckedDate: nowDate },
    ]);
    // 全 NOW 新鲜、无 flag → 干净
    expect(plan!.freshness.stale).toBe(false);
    expect(plan!.reviewStatus.pending).toBe(false);
  });

  it('关联源 pending flag 传导 → plan.reviewStatus.pending', async () => {
    const vendorId = await makeVendor('srcflag');
    const planId = await makePlan(vendorId, 'srcflag');
    const [src] = await db!
      .insert(schema.mrSource)
      .values({ sourceUrl: `${PREFIX}src-srcflag`, vendorId, fetchStrategy: 'http', lastChecked: NOW })
      .returning();
    await db!.insert(schema.mrPlanSources).values({ planId, sourceId: src!.id });
    await db!.insert(schema.mrReviewFlag).values({
      targetType: 'source',
      targetId: src!.id,
      reason: `${PREFIX}source-pending`,
      status: 'pending',
    });

    const plan = await snapPlan(planId);
    expect(plan!.reviewStatus.pending).toBe(true);
  });

  it('vendor pending flag 传导 → 其名下 plan.reviewStatus.pending', async () => {
    const vendorId = await makeVendor('vflag');
    const planId = await makePlan(vendorId, 'vflag');
    await db!.insert(schema.mrReviewFlag).values({
      targetType: 'vendor',
      targetId: vendorId,
      reason: `${PREFIX}vendor-pending`,
      status: 'pending',
    });

    const plan = await snapPlan(planId);
    expect(plan!.reviewStatus.pending).toBe(true);
  });

  it('resolved flag 不触发待复核', async () => {
    const vendorId = await makeVendor('resolved');
    const planId = await makePlan(vendorId, 'resolved');
    await db!.insert(schema.mrReviewFlag).values({
      targetType: 'plan',
      targetId: planId,
      reason: `${PREFIX}plan-resolved`,
      status: 'resolved',
    });

    const plan = await snapPlan(planId);
    expect(plan!.reviewStatus.pending).toBe(false);
  });

  it('非法枚举 review_flag → 快照构建抛错 fail-closed（不静默忽略坏 flag）', async () => {
    const vendorId = await makeVendor('badflag');
    const planId = await makePlan(vendorId, 'badflag');
    const [bad] = await db!
      .insert(schema.mrReviewFlag)
      .values({
        targetType: 'plan',
        targetId: planId,
        reason: `${PREFIX}flag-badstatus`,
        status: '__bogus_status__', // DB 零-CHECK 放行，聚合前 Zod 闸应拒（不静默忽略）
      })
      .returning();
    try {
      await expect(buildModelRadarSnapshot(db!, NOW, THRESHOLD_DAYS)).rejects.toThrow();
    } finally {
      // 立即清理，避免坏 flag 污染同库其它套件的全局快照构建。
      await db!.delete(schema.mrReviewFlag).where(eq(schema.mrReviewFlag.id, bad!.id));
    }
  });

  it('跨厂 plan_model junction → 快照构建抛错 fail-closed（同厂 ownership 校验）', async () => {
    const vendorA = await makeVendor('ownerA');
    const vendorB = await makeVendor('ownerB');
    const planId = await makePlan(vendorA, 'owner'); // plan 属 vendorA
    // model 属他厂 vendorB，经坏 junction 挂到本 plan → ownership 违例。
    const [model] = await db!
      .insert(schema.mrModels)
      .values({ vendorId: vendorB, family: `${PREFIX}fam-owner`, version: '1.0' })
      .returning();
    const [pm] = await db!
      .insert(schema.mrPlanModels)
      .values({
        planId,
        modelId: model!.id,
        sourceUrl: `${PREFIX}src-owner`,
        lastChecked: NOW,
        sourceConfidence: 'official_community',
      })
      .returning();
    try {
      await expect(buildModelRadarSnapshot(db!, NOW, THRESHOLD_DAYS)).rejects.toThrow();
    } finally {
      // 立即清理坏 junction，避免污染同库其它套件的全局快照构建。
      await db!.delete(schema.mrPlanModels).where(eq(schema.mrPlanModels.id, pm!.id));
    }
  });

  it('从未抓 browser 源（last_checked NULL）判陈旧，不被 now-NULL 误判新鲜', async () => {
    const vendorId = await makeVendor('nullsrc');
    // plan 自身 fresh，但关联源 last_checked NULL → 聚合 stale。
    const planId = await makePlan(vendorId, 'nullsrc', { lastChecked: NOW });
    const [src] = await db!
      .insert(schema.mrSource)
      .values({
        sourceUrl: `${PREFIX}src-nullsrc`,
        vendorId,
        fetchStrategy: 'browser',
        contentFingerprint: null,
        lastChecked: null,
      })
      .returning();
    await db!.insert(schema.mrPlanSources).values({ planId, sourceId: src!.id });

    const plan = await snapPlan(planId);
    expect(plan!.freshness.stale).toBe(true);
    // 关联源 last_checked NULL → 其 lastCheckedDate 缺省为 null（仅 source 行 date 可 null）。
    expect(plan!.sources[0]!.lastCheckedDate).toBeNull();
  });

  it('child 限额行陈旧 → plan freshness.stale（plan 自身新鲜亦然）', async () => {
    const vendorId = await makeVendor('childstale');
    const planId = await makePlan(vendorId, 'childstale', { lastChecked: NOW });
    await db!.insert(schema.mrPlanLimits).values({
      planId,
      limitType: 'monthly_tokens',
      value: '1000000',
      window: 'month',
      sourceUrl: `${PREFIX}src-childstale`,
      lastChecked: OLD,
      sourceConfidence: 'official_pricing',
    });

    const plan = await snapPlan(planId);
    expect(plan!.freshness.stale).toBe(true);
  });

  it('周期价去规范化读回 + effectiveMonthly + provenance date，且纳入 freshness', async () => {
    const vendorId = await makeVendor('period');
    const planId = await makePlan(vendorId, 'period', {
      currentPrice: '49.00',
      currency: 'CNY',
      lastChecked: NOW,
    });
    await db!.insert(schema.mrPlanPrices).values({
      planId,
      billingPeriod: 'annual',
      price: '468.00',
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-period-annual`,
      lastChecked: OLD,
      sourceConfidence: 'official_pricing',
    });
    await db!.insert(schema.mrPlanPrices).values({
      planId,
      billingPeriod: 'quarterly',
      price: null,
      currency: 'CNY',
      sourceUrl: `${PREFIX}src-period-quarterly`,
      lastChecked: NOW,
      sourceConfidence: 'needs_login_recheck',
    });

    const plan = await snapPlan(planId);
    expect(plan!.periodPrices).toEqual([
      {
        billingPeriod: 'annual',
        price: '468.00',
        currency: 'CNY',
        priceStatus: 'known',
        provenance: {
          sourceUrl: `${PREFIX}src-period-annual`,
          sourceConfidence: 'official_pricing',
          lastCheckedDate: OLD.toISOString().slice(0, 10),
        },
        effectiveMonthly: 39,
      },
      {
        billingPeriod: 'quarterly',
        price: null,
        currency: 'CNY',
        priceStatus: 'unknown',
        provenance: {
          sourceUrl: `${PREFIX}src-period-quarterly`,
          sourceConfidence: 'needs_login_recheck',
          lastCheckedDate: NOW.toISOString().slice(0, 10),
        },
        effectiveMonthly: null,
      },
    ]);
    expect(plan!.freshness.stale).toBe(true);
  });

  it('token_plan 周期价不生成 effectiveMonthly', async () => {
    const vendorId = await makeVendor('token-period');
    const planId = await makePlan(vendorId, 'token-period', {
      currentPrice: '5.00',
      currency: 'USD',
    });
    await db!
      .update(schema.mrPlans)
      .set({ category: 'token_plan' })
      .where(eq(schema.mrPlans.id, planId));
    await db!.insert(schema.mrPlanPrices).values({
      planId,
      billingPeriod: 'annual',
      price: '120.00',
      currency: 'USD',
      sourceUrl: `${PREFIX}src-token-period`,
      lastChecked: NOW,
      sourceConfidence: 'official_pricing',
    });

    const plan = await snapPlan(planId);
    expect(plan!.category).toBe('token_plan');
    expect(plan!.periodPrices[0]!.priceStatus).toBe('known');
    expect(plan!.periodPrices[0]!.effectiveMonthly).toBeNull();
  });

  it('unknown price 无损读回（占位 NULL 与非官方 confidence 带价均 unknown）', async () => {
    const vendorId = await makeVendor('unknown');
    // U1：登录墙占位 NULL。
    const u1 = await makePlan(vendorId, 'u1', {
      currentPrice: null,
      currency: null,
      sourceConfidence: 'needs_login_recheck',
    });
    // U2：非官方 confidence 带价（40 CNY needs_login_recheck）→ unknown，但原值无损保留。
    const u2 = await makePlan(vendorId, 'u2', {
      currentPrice: '40.00',
      currency: 'CNY',
      sourceConfidence: 'needs_login_recheck',
    });

    const p1 = await snapPlan(u1);
    expect(p1!.priceStatus).toBe('unknown');
    expect(p1!.currentPrice).toBeNull();
    expect(p1!.currency).toBeNull();

    const p2 = await snapPlan(u2);
    expect(p2!.priceStatus).toBe('unknown');
    expect(p2!.currentPrice).toBe('40.00');
    expect(p2!.currency).toBe('CNY');
  });

  it('并发写中途提交不产生撕裂快照（未提交不可见、提交后 plan+limit 原子可见）', async () => {
    const vendorId = await makeVendor('torn');
    let planBId: string | undefined;
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });

    // 写事务：插 plan B + 其 limit，捕获 id 后挂在 gate 上保持未提交。
    const writer = db!.transaction(async (tx) => {
      const [pb] = await tx
        .insert(schema.mrPlans)
        .values({
          vendorId,
          name: `${PREFIX}plan-torn-b`,
          category: 'coding_plan',
          currentPrice: '30.00',
          currency: 'USD',
          sourceUrl: `${PREFIX}src-torn-b`,
          lastChecked: NOW,
          sourceConfidence: 'official_pricing',
        })
        .returning();
      planBId = pb!.id;
      await tx.insert(schema.mrPlanLimits).values({
        planId: pb!.id,
        limitType: 'monthly_tokens',
        value: '2000000',
        window: 'month',
        sourceUrl: `${PREFIX}src-torn-b-lim`,
        lastChecked: NOW,
        sourceConfidence: 'official_pricing',
      });
      await gate; // 持锁未提交
    });

    try {
      // 等写事务到达 gate（id 已就绪、仍未提交）。
      for (let i = 0; i < 1000 && planBId === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(planBId).toBeDefined();

      // 未提交 → plan B 及其 limit 原子不可见。
      const snap1 = await buildModelRadarSnapshot(db!, NOW, THRESHOLD_DAYS);
      expect(snap1.plans.find((p) => p.id === planBId)).toBeUndefined();

      // 提交。
      releaseGate();
      await writer;

      // 提交后 → plan B 与其 limit 原子可见（不撕裂）。
      const snap2 = await buildModelRadarSnapshot(db!, NOW, THRESHOLD_DAYS);
      const found = snap2.plans.find((p) => p.id === planBId);
      expect(found).toBeDefined();
      expect(found!.limits).toHaveLength(1);
      expect(found!.limits[0]!.value).toBe('2000000');
    } finally {
      releaseGate();
      await writer.catch(() => undefined);
    }
  }, 20000);

  it('schema 校验失败 fail-closed：非法枚举 → 抛错、不返回坏快照', async () => {
    const vendorId = await makeVendor('badenum');
    const [bad] = await db!
      .insert(schema.mrPlans)
      .values({
        vendorId,
        name: `${PREFIX}plan-badenum`,
        category: 'coding_plan',
        currentPrice: null,
        currency: null,
        sourceUrl: `${PREFIX}src-badenum`,
        lastChecked: NOW,
        sourceConfidence: '__bogus_confidence__', // DB 零-CHECK 放行，Zod 闸应拒
      })
      .returning();
    try {
      await expect(buildModelRadarSnapshot(db!, NOW, THRESHOLD_DAYS)).rejects.toThrow();
    } finally {
      // 立即清理，避免坏行污染同库其它套件的全局快照构建。
      await db!.delete(schema.mrPlans).where(eq(schema.mrPlans.id, bad!.id));
    }
  });
});
