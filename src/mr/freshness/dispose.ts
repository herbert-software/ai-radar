/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）人工 dispose 最小面（task 3.1，design D6）。
 *
 * 保鲜回路闭环的「出口」：propose（打标）→ 人工 dispose（resolve + 刷 last_checked），否则 flag 只进不出、
 * 陈旧度（D9）反复重打标。最小面 = 两个函数（非后台/UI）：
 * - `listPendingFlags({ targetType?, olderThanMs? })`：列 pending flags，**age 键于 `opened_at`**
 *   （最新触发/重开时刻，配 D5 无条件 `opened_at=now()`）。
 * - `markChecked(target)`：**同一事务**内 `resolveFlag` + 按标的粒度刷 last_checked——防 resolve 成功但
 *   last_checked 未刷致下轮 D9 重开（原子性是正确性前提）。
 *
 * 粒度刷新（design D6）：
 * - `source` 标的 → 刷 `mr_source.last_checked`。
 * - `plan` 标的 → 刷 `mr_plans.last_checked` **及其全部 child 事实行**（`mr_plan_limits`/`mr_plan_clients`/
 *   `mr_plan_models`）的 `last_checked`。这是为闭合「junction/limit 触发 plan flag → 只刷 mr_plans →
 *   D9 重扫 child → 复打标跑步机」（spec R2）。
 *   `ponytail:` 全刷 child 是刻意权衡——窄因复核（如只看了价格）会把没看的兄弟 child 也盖成 fresh、
 *   掩盖其真陈旧；掩盖有界（≤1 个 D9 阈值窗口 = `MR_STALENESS_THRESHOLD_DAYS` 默认 30 天，后必重触发，
 *   非永久），单写者策展下「复核 plan = 复核整行集」可接受。要 per-row 精度须给 mr_review_flag 加 child
 *   引用列（改 5a schema）= 越界留后。
 * - `vendor` 标的 → 无对应 freshness 列（vendor 是身份表，无 last_checked），仅 resolve。
 *
 * 本模块只 `resolveFlag`（A 写入口）+ 直接 UPDATE 各表 `last_checked`（freshness 列、非事实字段，允许直写）；
 * **不 import `src/mr/ingest/`** 事实 writer。
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  mrPlanClients,
  mrPlanLimits,
  mrPlanModels,
  mrPlanPrices,
  mrPlans,
  mrReviewFlag,
  mrSource,
} from '../../db/schema.js';
import { mrReviewFlagTargetTypeSchema } from '../../db/mr-schema.zod.js';
import { resolveFlag, type ReviewFlagTarget } from '../write/flag.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测（对齐 write/flag.ts）。 */
type DbLike = typeof defaultDb;

/** pending flag 行（dispose 面只需展示/选取所需字段）。 */
export interface PendingFlag {
  targetType: string;
  targetId: string;
  reason: string | null;
  /**
   * `opened_at` 的 full-precision text（如 `'2026-06-25 10:00:00.123456+00'`）——精度安全地回传给
   * `markChecked({ expectedOpenedAt })` 做 generation 判别（走 JS Date 会丢 timestamptz 微秒，#20）。
   */
  openedAtText: string;
}

/** listPendingFlags 过滤项（均可选；不传 = 列全部 pending）。 */
export interface ListPendingFlagsOptions {
  /** 仅列该 target_type（plan/source/vendor）；不传列全部。 */
  targetType?: string;
  /** 仅列 `opened_at` 早于「now - olderThanMs」的（按 age 筛；不传不限龄）。 */
  olderThanMs?: number;
}

export type MarkCheckedResult =
  | { outcome: 'checked' }
  // 无 pending 标，或传了 expectedOpenedAt 但已被重开/resolve（generation mismatch）——合并单态：
  // 两者都「未 resolve 当前 pending」，处理一致（不刷 last_checked，#4 不凭空清陈旧）。
  | { outcome: 'not-resolved' };

/** markChecked 可选项：调用方（如 listPendingFlags）回传 list 时见到的 opened_at，做跨调用重开判别。 */
export interface MarkCheckedOptions {
  /**
   * 人在 `listPendingFlags` 时看到的 opened_at（**full-precision text**，取自 `PendingFlag.openedAtText`）。
   * 传则仅 resolve 该 generation——挡「人在 list 后、markChecked 前该 flag 被重开」的旧复核误清新标（#20）。
   * 不传则原子 resolve 当前 pending（无跨调用窗口时的常规路径）。
   */
  expectedOpenedAt?: string;
}

/**
 * 列 pending flags（design D6）。age 键于 `opened_at`（D5 无条件 `opened_at=now()`，故它是最新触发/重开时刻）。
 * 默认按 `opened_at` 升序（最老的最先复核）。
 */
export async function listPendingFlags(
  dbh: DbLike = defaultDb,
  options: ListPendingFlagsOptions = {},
): Promise<PendingFlag[]> {
  const conds = [eq(mrReviewFlag.status, 'pending')];
  if (options.targetType !== undefined) {
    conds.push(eq(mrReviewFlag.targetType, options.targetType));
  }
  if (options.olderThanMs !== undefined) {
    // opened_at < now() - interval：用 SQL now() 与 DB 同源比较，避免 app/DB 时钟漂移。
    conds.push(
      lt(
        mrReviewFlag.openedAt,
        sql`now() - make_interval(secs => ${options.olderThanMs / 1000})`,
      ),
    );
  }

  return dbh
    .select({
      targetType: mrReviewFlag.targetType,
      targetId: mrReviewFlag.targetId,
      reason: mrReviewFlag.reason,
      // full-precision text：使调用方能精度安全地回传给 markChecked({ expectedOpenedAt })。
      openedAtText: sql<string>`${mrReviewFlag.openedAt}::text`,
    })
    .from(mrReviewFlag)
    .where(and(...conds))
    .orderBy(mrReviewFlag.openedAt);
}

/**
 * 标记某标的已复核（design D6）：**同一事务**内 generation-aware resolveFlag + 按粒度刷 last_checked。
 *
 * 原子性是正确性前提——若 resolve 与刷 last_checked 分两事务，resolve 成功但刷失败会令 D9 立即重开（flag
 * 永不出）；故 resolve、刷 freshness 全程裹在 `db.transaction` 内。
 *
 * generation 判别符（`opts.expectedOpenedAt`）**由调用方传入**（人在 `listPendingFlags` 时看到的 opened_at），
 * 非内部自读——自读当前 opened_at 再与自身比无法检测「人在 list 后、markChecked 前的跨调用重开」（#20）。
 * 不传则原子 resolve 当前 pending。
 *
 * @param dbh db 实例（自开事务）。
 * @param target 标的（target_type ∈ {plan,source,vendor}，过 resolveFlag 内 Zod 闸）。
 * @param opts expectedOpenedAt 可选（来自 listPendingFlags 的 openedAtText）。
 */
export async function markChecked(
  dbh: DbLike = defaultDb,
  target: ReviewFlagTarget,
  opts: MarkCheckedOptions = {},
): Promise<MarkCheckedResult> {
  const targetType = mrReviewFlagTargetTypeSchema.parse(target.targetType);

  return dbh.transaction(async (tx): Promise<MarkCheckedResult> => {
    const affected = await resolveFlag(
      tx,
      { targetType, targetId: target.targetId },
      opts.expectedOpenedAt !== undefined
        ? { expectedOpenedAt: opts.expectedOpenedAt }
        : {},
    );
    if (affected === 0) {
      // 无 pending 标，或传了 expectedOpenedAt 但已被重开/resolve（generation mismatch）。
      // 两者皆「未 resolve 当前 pending」→ 不刷 last_checked（#4：不凭空清陈旧）。
      return { outcome: 'not-resolved' };
    }

    if (targetType === 'source') {
      await tx
        .update(mrSource)
        .set({ lastChecked: sql`now()` })
        .where(eq(mrSource.id, target.targetId));
    } else if (targetType === 'plan') {
      // plan 标的：刷 mr_plans 自身 + 全部 child 事实行（design D6 全刷 child，闭合跑步机）。
      const ts = sql`now()`;
      await tx
        .update(mrPlans)
        .set({ lastChecked: ts })
        .where(eq(mrPlans.id, target.targetId));
      await tx
        .update(mrPlanLimits)
        .set({ lastChecked: ts })
        .where(eq(mrPlanLimits.planId, target.targetId));
      await tx
        .update(mrPlanClients)
        .set({ lastChecked: ts })
        .where(eq(mrPlanClients.planId, target.targetId));
      await tx
        .update(mrPlanModels)
        .set({ lastChecked: ts })
        .where(eq(mrPlanModels.planId, target.targetId));
      await tx
        .update(mrPlanPrices)
        .set({ lastChecked: ts })
        .where(eq(mrPlanPrices.planId, target.targetId));
    }
    // vendor 标的：身份表无 last_checked 列，仅 resolve（已在上方完成）。
    return { outcome: 'checked' };
  });
}
