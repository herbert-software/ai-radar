/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）只读快照构建器（task 2.2/2.3/2.4，design D1/D2/D8）。
 *
 * `buildModelRadarSnapshot(db, now, thresholdDays)`：在**单事务 point-in-time 一致**视图内读构建所需 9 张 `mr_*`，
 * 去规范化为 `ModelRadarSnapshot`，经 Zod 校验后返回。
 *
 * 读 9 张表（**不读** `mr_price_history`——比价只需 current 价；**不读** `mr_catalog_version`——5c 公开
 * version 由内容哈希派生，该表不读不写不服务，design D1）：
 *   vendors / plans / models / plan_models / plan_clients / plan_limits / source / plan_sources / review_flag。
 *
 * 一致读（design D2 / spec「快照单事务一致读不撕裂」）：`isolationLevel:'repeatable read'` +
 * `accessMode:'read only'`，**纯 SELECT、禁 FOR UPDATE/SHARE**。跨多表多语句读时，构建中途有写提交会产生
 * 跨表撕裂（plan 读到却漏其刚写的 child）；逐行 Zod 校验捕获不到「每行单独合法但跨表不一致」。只读 SELECT 取
 * ACCESS SHARE，与改价的 ROW EXCLUSIVE/FOR UPDATE 在 PG MVCC 下互不阻塞、无死锁。各表 `ORDER BY id` 固定
 * 数组/行序，使组 D 内容哈希 canonical（PG 无 ORDER BY 返回物理序会让无数据变化的哈希漂移）。
 *
 * 陈旧/待复核聚合（design D1/D9，与既有 staleness 排程同口径 src/mr/freshness/staleness.ts）：
 * - freshness.stale = plan 自身 + child 事实行（limits/clients/models）+ 关联源 last_checked **任一陈旧**；
 *   陈旧 = `last_checked IS NULL 或 < (now − 阈值)`。**NULL 分支仅 `mr_source.last_checked` 可达**（DDL 仅它
 *   nullable）——从未抓的 browser 源（last_checked NULL）必须判陈旧，不因 `now − NULL` 误判新鲜。
 * - reviewStatus.pending = 直接 plan flag / vendor flag / 经 mr_plan_sources 关联的 source flag **任一 pending**。
 *
 * per-fact age（5d-B / design D1）：每条事实行 provenance（plan 价格事实 + models/clients/limits）+ 关联源行带
 * 日粒度 `lastCheckedDate` = `trunc_UTC(该行 last_checked)`（见 `truncToUtcDate`）；价格事实 date = `trunc(plan.last_checked)`
 * 单行列、非跨事实聚合（不暴露 plan 级聚合 date）；`mr_source.last_checked` NULL → date 缺省 null（仍判陈旧）。
 * 按固定 UTC 截断、完全 now 无关 → 进内容哈希仍稳定、跨进程一致。
 *
 * fail-closed（task 2.4 / spec「schema 校验失败不对外服务」）：构建结果缺必需 provenance/非法枚举/引用悬空时
 * 抛错、**不返回坏快照**。缓存/不覆盖旧快照/冷启动 503 是组 D 缓存层职责——本 builder 只保证校验失败抛错。
 */
// env-clean（design D5）：仅 `type DbLike = typeof defaultDb` 用 → `import type`（verbatimModuleSyntax 下运行期擦除），
// 使 MCP 进程（仅 DATABASE_URL）可 `await import` 本模块而**不**触 `db/index.ts`→`config/env.ts` 的全局 parseEnv。
import type { db as defaultDb } from '../../db/index.js';
import {
  isOfficialConfidence,
  mrBillingPeriodSchema,
  mrReviewFlagStatusSchema,
  mrReviewFlagTargetTypeSchema,
} from '../../db/mr-schema.zod.js';
import {
  mrModels,
  mrPlanClients,
  mrPlanLimits,
  mrPlanModels,
  mrPlanPrices,
  mrPlanSources,
  mrPlans,
  mrReviewFlag,
  mrSource,
  mrVendors,
} from '../../db/schema.js';
import {
  modelRadarSnapshotSchema,
  type ModelRadarSnapshot,
} from './dto.js';
import { effectiveMonthly } from '../effective-monthly.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测（对齐 staleness.ts / flag.ts）。 */
type DbLike = typeof defaultDb;

const DAY_MS = 86_400_000;
const PENDING = 'pending';

/** 陈旧判定（与 staleness 排程同口径）：从未核对（NULL）或超阈值即陈旧。 */
function isStale(lastChecked: Date | null, threshold: Date): boolean {
  return lastChecked === null || lastChecked < threshold;
}

/**
 * per-fact age（5d-B / design D1）：把事实行 `last_checked` 截断到**日粒度 ISO 日期** `YYYY-MM-DD`。
 * **按固定 UTC 截断**（`toISOString()` 恒 UTC）——`lastCheckedDate` 是该 DB 行值的纯函数、**完全与 build/render
 * `now` 无关**（now 推进即便跨任何 UTC 午夜也不改它，仅该行 `last_checked` 被写到新 UTC 日才变），故进内容哈希
 * 仍稳定、不每日过度失效。**禁按进程本地 TZ（`getDate()` 等）**：否则同一 `timestamptz` 瞬间在不同 `process.env.TZ`
 * 进程截成不同日 → 内容哈希分叉 → 破 5d-A 跨进程免协调一致性。「N 天前」相对文案只在 render 层算、绝不进 DTO/哈希。
 */
function truncToUtcDate(lastChecked: Date): string {
  return lastChecked.toISOString().slice(0, 10);
}

/** 按 key 分组、保留输入顺序（输入已按 id 升序 → 各组内仍 id 升序，保 canonical）。 */
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const arr = map.get(k);
    if (arr) arr.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/**
 * 构建只读快照。
 *
 * @param dbh    db 实例或已开事务句柄（注入桩/集成测用）。
 * @param now    参考时刻（**可注入**：供 CI 断言陈旧/阈值穿越）。staleness 阈值 = now − thresholdDays。
 * @param thresholdDays 陈旧阈值天数（**必填**，由调用方显式喂同一 `MR_STALENESS_THRESHOLD_DAYS` 口径——
 *   app 进程经 cache.ts 喂 `env.MR_STALENESS_THRESHOLD_DAYS`、MCP 进程经 `mcpEnvSchema` 同源值；
 *   env-clean 后本模块不再顶层 import `config/env.ts`，故不设默认值）。
 * @returns 经 Zod 校验的快照；校验失败时**抛错**（fail-closed，不返回坏快照）。
 */
export async function buildModelRadarSnapshot(
  dbh: DbLike,
  now: Date,
  thresholdDays: number,
): Promise<ModelRadarSnapshot> {
  // fail-closed：thresholdDays 现由 caller 供（env-clean 后无默认），非正整数会静默歪曲陈旧截断 → 抛错。
  if (!Number.isInteger(thresholdDays) || thresholdDays <= 0) {
    throw new Error(`buildModelRadarSnapshot: thresholdDays 须为正整数天数，收到 ${thresholdDays}`);
  }
  const threshold = new Date(now.getTime() - thresholdDays * DAY_MS);

  // 单事务 REPEATABLE READ + read only：point-in-time 一致读，禁行锁。各表 ORDER BY id 固定行序。
  // 同一连接顺序 await（不并行——单 pg client 不可多路复用；REPEATABLE READ 下顺序读仍 point-in-time 一致）。
  const built = await dbh.transaction(
    async (tx) => {
      const vendors = await tx.select().from(mrVendors).orderBy(mrVendors.id);
      const plans = await tx.select().from(mrPlans).orderBy(mrPlans.id);
      const models = await tx.select().from(mrModels).orderBy(mrModels.id);
      const planModels = await tx.select().from(mrPlanModels).orderBy(mrPlanModels.id);
      const planClients = await tx.select().from(mrPlanClients).orderBy(mrPlanClients.id);
      const planLimits = await tx.select().from(mrPlanLimits).orderBy(mrPlanLimits.id);
      const planPrices = await tx
        .select()
        .from(mrPlanPrices)
        .orderBy(mrPlanPrices.planId, mrPlanPrices.billingPeriod, mrPlanPrices.currency);
      const sources = await tx.select().from(mrSource).orderBy(mrSource.id);
      const planSources = await tx.select().from(mrPlanSources).orderBy(mrPlanSources.id);
      const reviewFlags = await tx.select().from(mrReviewFlag).orderBy(mrReviewFlag.id);

      const vendorById = new Map(vendors.map((v) => [v.id, v]));
      const modelById = new Map(models.map((m) => [m.id, m]));
      const sourceById = new Map(sources.map((s) => [s.id, s]));
      const planIds = new Set(plans.map((p) => p.id));
      for (const pp of planPrices) {
        if (!planIds.has(pp.planId)) {
          throw new Error(
            `快照构建：plan_price ${pp.id} 引用不存在的 plan ${pp.planId}`,
          );
        }
      }

      const modelsByPlan = groupBy(planModels, (r) => r.planId);
      const clientsByPlan = groupBy(planClients, (r) => r.planId);
      const limitsByPlan = groupBy(planLimits, (r) => r.planId);
      const pricesByPlan = groupBy(planPrices, (r) => r.planId);
      const planSourcesByPlan = groupBy(planSources, (r) => r.planId);

      // pending flag 集（仅 status='pending' 计入；resolved 不触发待复核）。
      // target_type/status 为零-CHECK text 列，Zod 是唯一闸：聚合前 parse，非法枚举 fail-closed 抛错
      // （静默忽略会让带坏 pending flag 的 plan 显示干净，违反「不把已 flag 的 plan 显示干净」不变量）。
      const planPending = new Set<string>();
      const vendorPending = new Set<string>();
      const sourcePending = new Set<string>();
      for (const f of reviewFlags) {
        const targetType = mrReviewFlagTargetTypeSchema.parse(f.targetType);
        const status = mrReviewFlagStatusSchema.parse(f.status);
        if (status !== PENDING) continue;
        if (targetType === 'plan') planPending.add(f.targetId);
        else if (targetType === 'vendor') vendorPending.add(f.targetId);
        else if (targetType === 'source') sourcePending.add(f.targetId);
      }

      const snapshotPlans = plans.map((plan) => {
        const vendor = vendorById.get(plan.vendorId);
        // 引用完整性是 5b 录入契约（零 FK）；悬空引用 = 坏数据 → fail-closed 抛错（不静默吞、不返回坏快照）。
        if (!vendor) {
          throw new Error(
            `快照构建：plan ${plan.id} 引用不存在的 vendor ${plan.vendorId}`,
          );
        }

        const modelRows = modelsByPlan.get(plan.id) ?? [];
        const dtoModels = modelRows.map((pm) => {
          const model = modelById.get(pm.modelId);
          if (!model) {
            throw new Error(
              `快照构建：plan_model ${pm.id} 引用不存在的 model ${pm.modelId}`,
            );
          }
          // 同厂 ownership（fail-closed）：坏 junction 不得把他厂 model 挂到本 plan。
          if (model.vendorId !== plan.vendorId) {
            throw new Error(
              `快照构建：plan_model ${pm.id} 的 model 不属于 vendor ${plan.vendorId}`,
            );
          }
          return {
            modelId: model.id,
            family: model.family,
            version: model.version,
            provenance: {
              sourceUrl: pm.sourceUrl,
              sourceConfidence: pm.sourceConfidence,
              lastCheckedDate: truncToUtcDate(pm.lastChecked),
            },
          };
        });

        const clientRows = clientsByPlan.get(plan.id) ?? [];
        const dtoClients = clientRows.map((c) => ({
          clientType: c.clientType,
          clientId: c.clientId,
          provenance: {
            sourceUrl: c.sourceUrl,
            sourceConfidence: c.sourceConfidence,
            lastCheckedDate: truncToUtcDate(c.lastChecked),
          },
        }));

        const limitRows = limitsByPlan.get(plan.id) ?? [];
        const dtoLimits = limitRows.map((l) => ({
          limitType: l.limitType,
          value: l.value,
          window: l.window,
          provenance: {
            sourceUrl: l.sourceUrl,
            sourceConfidence: l.sourceConfidence,
            lastCheckedDate: truncToUtcDate(l.lastChecked),
          },
        }));

        const priceRows = pricesByPlan.get(plan.id) ?? [];
        const dtoPeriodPrices = priceRows.map((pp) => {
          const billingPeriod = mrBillingPeriodSchema.parse(pp.billingPeriod);
          const priceStatus =
            pp.price !== null && isOfficialConfidence(pp.sourceConfidence)
              ? 'known'
              : 'unknown';
          return {
            billingPeriod,
            price: pp.price,
            currency: pp.currency,
            priceStatus,
            provenance: {
              sourceUrl: pp.sourceUrl,
              sourceConfidence: pp.sourceConfidence,
              lastCheckedDate: truncToUtcDate(pp.lastChecked),
            },
            effectiveMonthly:
              plan.category === 'token_plan'
                ? null
                : effectiveMonthly(pp.price, billingPeriod, priceStatus),
          };
        });

        const sourceRows = (planSourcesByPlan.get(plan.id) ?? []).map((ps) => {
          const source = sourceById.get(ps.sourceId);
          if (!source) {
            throw new Error(
              `快照构建：plan_source ${ps.id} 引用不存在的 source ${ps.sourceId}`,
            );
          }
          // 同厂 ownership（fail-closed）：坏 junction 不得让他厂 source 串进本 plan（含其 stale/pending）。
          if (source.vendorId !== plan.vendorId) {
            throw new Error(
              `快照构建：plan_source ${ps.id} 的 source 不属于 vendor ${plan.vendorId}`,
            );
          }
          return source;
        });
        const dtoSources = sourceRows.map((s) => ({
          sourceUrl: s.sourceUrl,
          fetchStrategy: s.fetchStrategy,
          // mr_source.last_checked 可 NULL（从未抓源）→ date 缺省 null（仍经 isStale 判陈旧）。
          lastCheckedDate: s.lastChecked === null ? null : truncToUtcDate(s.lastChecked),
        }));

        // freshness 聚合：plan 自身 + child 事实行 + 关联源 last_checked 任一陈旧。
        const stale =
          isStale(plan.lastChecked, threshold) ||
          limitRows.some((l) => isStale(l.lastChecked, threshold)) ||
          priceRows.some((p) => isStale(p.lastChecked, threshold)) ||
          clientRows.some((c) => isStale(c.lastChecked, threshold)) ||
          modelRows.some((m) => isStale(m.lastChecked, threshold)) ||
          sourceRows.some((s) => isStale(s.lastChecked, threshold));

        // reviewStatus 聚合：plan flag / vendor flag / 关联 source flag 任一 pending。
        const pending =
          planPending.has(plan.id) ||
          vendorPending.has(plan.vendorId) ||
          sourceRows.some((s) => sourcePending.has(s.id));

        // priceStatus：known ⟺ 价/币非 NULL 且 source_confidence 属已核官方集合（design D4）。
        const priceStatus =
          plan.currentPrice !== null &&
          plan.currency !== null &&
          isOfficialConfidence(plan.sourceConfidence)
            ? 'known'
            : 'unknown';

        return {
          id: plan.id,
          vendorId: plan.vendorId,
          vendorName: vendor.name,
          name: plan.name,
          category: plan.category,
          availability: plan.availability,
          currentPrice: plan.currentPrice,
          currency: plan.currency,
          priceStatus,
          provenance: {
            sourceUrl: plan.sourceUrl,
            sourceConfidence: plan.sourceConfidence,
            // 价格事实 date = trunc(plan.last_checked)（单行列、非跨事实聚合，design D1）。
            lastCheckedDate: truncToUtcDate(plan.lastChecked),
          },
          freshness: { stale },
          reviewStatus: { pending },
          periodPrices: dtoPeriodPrices,
          models: dtoModels,
          clients: dtoClients,
          limits: dtoLimits,
          sources: dtoSources,
        };
      });

      return { plans: snapshotPlans };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  // 提交后纯校验（fail-closed）：非法枚举/缺 provenance/known 不变量违例 → 抛错，不返回坏快照。
  return modelRadarSnapshotSchema.parse(built);
}
