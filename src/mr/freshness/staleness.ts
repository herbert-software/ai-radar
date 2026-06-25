/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）陈旧度排程（task 6.1，design D9）。
 *
 * 扫 `mr_source` **与各事实表**（`mr_plans`/`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`）的
 * `last_checked`，超阈值（`env.MR_STALENESS_THRESHOLD_DAYS` 默认 30 天）进复核：
 * - source 超期 → 给 source 自身打 `target_type='source'` flag；
 * - junction/limit 超期 → **给其所属 plan 打 `target_type='plan'` flag**（reason 注明是兼容/限额行陈旧，
 *   落地 5a「兼容陈旧经所属 plan 复核」的意图，覆盖「兼容矩阵最易过时」的死角）。
 *
 * **NULL 语义（design D9）**：`last_checked IS NULL`（从未核对，如 manual/needs_login 占位）= 最该复核，
 * 判定为 `last_checked IS NULL OR last_checked < threshold`，不被静默跳过。
 *
 * `ponytail:` 五表各一次 seq scan（低百行，B-tree 索引过早）；行数破万再加 `idx_<t>_last_checked`
 * （`ASC NULLS FIRST` 使 NULL 集 + `< threshold` 段单次前向扫，避开 OR-NULL 非 sargable 陷阱）。
 *
 * 本模块只 `setReviewFlag`（A 写入口）+ 只读 SELECT 各表；**不 import `src/mr/ingest/`** 事实 writer、不改事实。
 * 多 plan/source 打标 per-target 独立（setReviewFlag 单语句 CAS 自治、幂等收敛单行）；同一 run 内同 plan 经
 * 多个陈旧 child 命中只首次打标（本地去重，省重复 CAS）。
 */
import { lt, or, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  mrPlanClients,
  mrPlanLimits,
  mrPlanModels,
  mrPlans,
  mrSource,
} from '../../db/schema.js';
import { setReviewFlag } from '../write/flag.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测（对齐 write/flag.ts）。 */
type DbLike = typeof defaultDb;

/** runStaleness 结果（供编排/可观测）。 */
export interface RunStalenessResult {
  /** 打 source flag 的 source id 数。 */
  sourceFlagged: number;
  /** 打 plan flag 的 plan id 数（去重后；source/limit/junction 陈旧均经所属 plan）。 */
  planFlagged: number;
}

export interface RunStalenessOptions {
  /** 阈值天数（默认 env.MR_STALENESS_THRESHOLD_DAYS）。 */
  thresholdDays?: number;
  /** 参考时刻（默认当前；阈值边界 = now - thresholdDays）。 */
  now?: Date;
}

/** 各事实表对应的 plan 级 reason 前缀（注明哪类行陈旧，落地 design D9 reason 注明）。 */
const REASON_PLAN_SELF = '套餐价格信息陈旧';
const REASON_LIMIT = '限额行陈旧';
const REASON_CLIENT = '工具/协议兼容行陈旧';
const REASON_MODEL = '模型兼容行陈旧';
const REASON_SOURCE = '来源页面长期未核对';

/**
 * 陈旧度纯函数（design D9）。扫五表 last_checked 超阈值/NULL → 打 flag。
 *
 * @param dbh db 实例或已开事务句柄（注入桩用）。
 * @param env 透传 env（默认全局 env），取 MR_STALENESS_THRESHOLD_DAYS。
 */
export async function runStaleness(
  dbh: DbLike = defaultDb,
  options: RunStalenessOptions = {},
  envThresholdDays?: number,
): Promise<RunStalenessResult> {
  const thresholdDays = options.thresholdDays ?? envThresholdDays ?? 30;
  const now = options.now ?? new Date();
  const threshold = new Date(now.getTime() - thresholdDays * 86_400_000);

  // 陈旧判定：last_checked IS NULL（最该复核）OR < threshold（design D9 NULL 语义）。
  const stale = (col: Parameters<typeof lt>[0]) =>
    or(isNull(col), lt(col, threshold));

  // 同一 run 内 plan 去重（多个陈旧 child 命中同 plan 只打一次标，省重复 CAS）。
  const flaggedPlans = new Map<string, string>();
  const flagPlan = (planId: string, reason: string) => {
    if (!flaggedPlans.has(planId)) flaggedPlans.set(planId, reason);
  };

  // ① source 超期 → source flag。
  const staleSources = await dbh
    .select({ id: mrSource.id })
    .from(mrSource)
    .where(stale(mrSource.lastChecked));

  // ② plan 自身超期 → plan flag。
  const stalePlans = await dbh
    .select({ id: mrPlans.id })
    .from(mrPlans)
    .where(stale(mrPlans.lastChecked));
  for (const p of stalePlans) flagPlan(p.id, REASON_PLAN_SELF);

  // ③ limit 超期 → 所属 plan flag。
  const staleLimits = await dbh
    .select({ planId: mrPlanLimits.planId })
    .from(mrPlanLimits)
    .where(stale(mrPlanLimits.lastChecked));
  for (const l of staleLimits) flagPlan(l.planId, REASON_LIMIT);

  // ④ client junction 超期 → 所属 plan flag。
  const staleClients = await dbh
    .select({ planId: mrPlanClients.planId })
    .from(mrPlanClients)
    .where(stale(mrPlanClients.lastChecked));
  for (const c of staleClients) flagPlan(c.planId, REASON_CLIENT);

  // ⑤ model junction 超期 → 所属 plan flag。
  const staleModels = await dbh
    .select({ planId: mrPlanModels.planId })
    .from(mrPlanModels)
    .where(stale(mrPlanModels.lastChecked));
  for (const m of staleModels) flagPlan(m.planId, REASON_MODEL);

  // per-target 独立打标（每 CAS 自治，失败隔离，不裹批事务）。
  for (const s of staleSources) {
    await setReviewFlag(dbh, { targetType: 'source', targetId: s.id }, REASON_SOURCE);
  }
  for (const [planId, reason] of flaggedPlans) {
    await setReviewFlag(dbh, { targetType: 'plan', targetId: planId }, reason);
  }

  return { sourceFlagged: staleSources.length, planFlagged: flaggedPlans.size };
}
