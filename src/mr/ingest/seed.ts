/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）已核 8 家全桶 seed 录入（task 1.6/1.7）。
 *
 * 职责：用 Group B 的 `upsert*` + 本组的 `upsertPlanSource` 把 `seed-data.ts` 的 checked-in fixture 灌入
 * `mr_*`。全程过 5a Zod 闸（upsert* 内建）、**幂等可重跑**（identity 唯一键冲突→exists；fact 全同→noop；
 * 定位边 ON CONFLICT DO NOTHING）。
 *
 * 录入顺序（引用依赖）：vendor → (model 身份, source 身份) → plan → (limit/model 兼容/client 兼容 child)
 * → 定位边（source ↔ 同 vendor 全部 plan）。
 *
 * **不臆造价格**：fixture 价数无把握处为 `needs_login_recheck` 占位（currentPrice/currency NULL），
 * `upsertPlan` 不触发 recordPriceChange（无真价变），故 seed 只建占位结构，真价靠保鲜回路核实后录入。
 *
 * **不 bump catalog version、不投 rebuild**（design D16：5b 写 mr_* 不碰 mr_catalog_version，留 5c）。
 */
import { db as defaultDb } from '../../db/index.js';
import {
  upsertModel,
  upsertPlan,
  upsertPlanClient,
  upsertPlanLimit,
  upsertPlanModel,
  upsertPlanSource,
  upsertSource,
  upsertVendor,
} from './upsert.js';
import { SEED_VENDORS } from './seed-data.js';

/** db 句柄类型（顶层 drizzle 实例），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** seed 录入汇总（供脚本 artifact / 测试断言）。 */
export interface SeedResult {
  vendors: number;
  plans: number;
  limits: number;
  models: number;
  clients: number;
  sources: number;
  /** 录入的 (source_id, plan_id) 定位边数。 */
  planSources: number;
}

/**
 * 录入已核 8 家全桶 fixture（task 1.6/1.7）。幂等可重跑——所有写经 upsert*（identity exists / fact noop /
 * 定位边 DO NOTHING）。返回各表录入计数（含「已存」也计入，反映 fixture 规模而非新增行数）。
 *
 * @param dbh 顶层 db 实例（默认全局 db；测试注入隔离实例）。`upsertPlan` 内部自开事务委托改价
 *   （design D4 原子性），故须顶层 `DbLike`（非 `TxLike`）。
 */
export async function runSeed(dbh: DbLike = defaultDb): Promise<SeedResult> {
  const res: SeedResult = {
    vendors: 0,
    plans: 0,
    limits: 0,
    models: 0,
    clients: 0,
    sources: 0,
    planSources: 0,
  };

  for (const v of SEED_VENDORS) {
    const vendor = await upsertVendor(dbh, {
      normalizedName: v.normalizedName,
      name: v.name,
    });
    res.vendors += 1;

    // 抓取源身份（定位边端点）。源 id 按 fixture 顺序收集，供后续定位边录入。
    const sourceIds: string[] = [];
    for (const s of v.sources) {
      const src = await upsertSource(dbh, {
        vendorId: vendor.id,
        sourceUrl: s.sourceUrl,
        fetchStrategy: s.fetchStrategy,
      });
      sourceIds.push(src.id);
      res.sources += 1;
    }

    // 套餐 + child 事实行。plan id 收集供定位边录入。
    const planIds: string[] = [];
    for (const p of v.plans) {
      const plan = await upsertPlan(dbh, {
        vendorId: vendor.id,
        name: p.name,
        category: p.category,
        currentPrice: p.currentPrice,
        currency: p.currency,
        sourceUrl: p.sourceUrl,
        sourceConfidence: p.sourceConfidence,
      });
      res.plans += 1;
      // 幂等重跑分支：inserted/noop/conflict/price-delegated 均带 id；noop-race（无 id）极罕见，跳过 child。
      const planId = 'id' in plan ? plan.id : undefined;
      if (!planId) continue;
      planIds.push(planId);

      for (const l of p.limits) {
        await upsertPlanLimit(dbh, {
          planId,
          limitType: l.limitType,
          value: l.value,
          window: l.window,
          sourceUrl: p.sourceUrl,
          sourceConfidence: p.sourceConfidence,
        });
        res.limits += 1;
      }

      for (const m of p.models) {
        const model = await upsertModel(dbh, {
          vendorId: vendor.id,
          family: m.family,
          version: m.version,
        });
        res.models += 1;
        await upsertPlanModel(dbh, {
          planId,
          modelId: model.id,
          sourceUrl: p.sourceUrl,
          sourceConfidence: p.sourceConfidence,
        });
      }

      for (const c of p.clients) {
        await upsertPlanClient(dbh, {
          planId,
          clientType: c.clientType,
          clientId: c.clientId,
          sourceUrl: p.sourceUrl,
          sourceConfidence: p.sourceConfidence,
        });
        res.clients += 1;
      }
    }

    // 定位边（task 1.7）：每源 ↔ 同 vendor 全部 plan（「源指纹变 → 定位覆盖 plan 集合」可落地）。
    for (const sourceId of sourceIds) {
      for (const planId of planIds) {
        await upsertPlanSource(dbh, { sourceId, planId });
        res.planSources += 1;
      }
    }
  }

  return res;
}
