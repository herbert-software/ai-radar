/**
 * Model Radar（P5 / 5b，design D7）抓取指纹的**原子 compare-and-update** + 定位打标。
 *
 * 归 `src/mr/write/`（抓取链**允许** import 的唯一写入口集——flag/fingerprint/last_checked），
 * **绝不改 `mr_*` 价格/限额/兼容事实**（那些 writer 在 `src/mr/ingest/`，抓取链 eslint 禁 import）。
 *
 * 原子契约（同事务，design D7）：
 * ① `SELECT content_fingerprint, last_checked … WHERE id=sourceId FOR UPDATE`（锁源行取旧指纹）；
 * ② 比对新旧指纹：
 *    - **真变** → `UPDATE mr_source SET content_fingerprint=新, last_checked=now()` +
 *      经 `mr_plan_sources` 定位覆盖 plan 集合 → 逐个 `setReviewFlag(plan)`；
 *      **定位空集合 → 给 source 自身打 `target_type='source'` flag**（页面变动永不被吞）。
 *    - **无变化** → 仅 `UPDATE mr_source SET last_checked=now()`，**不打标**（stale 重试比到已更新指纹 → no-op，
 *      已 resolve 的 flag 不被旧 job 无条件重开，design D5 stale-retry 防护）。
 * 全程同事务 + FOR UPDATE，使「比对 → 更新 → 打标」原子，杜绝并发指纹检测互相覆盖。
 */
import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrSource, mrPlanSources } from '../../db/schema.js';
import { setReviewFlag } from './flag.js';

/** db 句柄类型（drizzle 实例或事务）。 */
type DbLike = typeof defaultDb;

/** compare-and-update 结果（供编排/可观测）。 */
export type FingerprintUpdateOutcome =
  /** 指纹真变：更新指纹 + 给 N 个覆盖 plan 打标。 */
  | { outcome: 'changed'; flaggedPlans: number }
  /** 指纹真变但无关联 plan：给 source 自身打标。 */
  | { outcome: 'changed-source-flag' }
  /** 无变化：仅刷 last_checked，不打标。 */
  | { outcome: 'unchanged' }
  /** 源不存在（容忍，不 NPE）。 */
  | { outcome: 'source-missing' };

/**
 * 原子比对并更新源指纹（design D7）。`newFingerprint` 为 `sha256(归一价格区域文本)` hex。
 * `reason` 为打标原因（注明是「页面变动」）。
 *
 * @param dbh db 实例（本入口自开 transaction；不接外层 tx——抓取检测自治、失败隔离）。
 */
export async function compareAndUpdateFingerprint(
  dbh: DbLike,
  sourceId: string,
  newFingerprint: string,
  reason: string,
): Promise<FingerprintUpdateOutcome> {
  return dbh.transaction(async (tx) => {
    // ① 锁源行取旧指纹（FOR UPDATE 串行化并发指纹检测）。
    const existing = await tx
      .select({ fingerprint: mrSource.contentFingerprint })
      .from(mrSource)
      .where(eq(mrSource.id, sourceId))
      .for('update');

    if (existing.length === 0) {
      // 源不存在（容忍，不 NPE——抓取目标可能已被删）。
      return { outcome: 'source-missing' } as const;
    }

    const oldFingerprint = existing[0]!.fingerprint;

    // ② 无变化（含 stale 重试比到已更新指纹）→ 仅刷 last_checked，不打标。
    if (oldFingerprint === newFingerprint) {
      await tx
        .update(mrSource)
        .set({ lastChecked: sql`now()` })
        .where(eq(mrSource.id, sourceId));
      return { outcome: 'unchanged' } as const;
    }

    // ② 真变：更新指纹 + last_checked。
    await tx
      .update(mrSource)
      .set({ contentFingerprint: newFingerprint, lastChecked: sql`now()` })
      .where(eq(mrSource.id, sourceId));

    // 经 mr_plan_sources 定位覆盖 plan 集合。
    const planRows = await tx
      .select({ planId: mrPlanSources.planId })
      .from(mrPlanSources)
      .where(eq(mrPlanSources.sourceId, sourceId));

    if (planRows.length === 0) {
      // 定位空集合 → 给 source 自身打标（页面变动永不被吞，design D7）。
      await setReviewFlag(tx, { targetType: 'source', targetId: sourceId }, reason);
      return { outcome: 'changed-source-flag' } as const;
    }

    // 逐个给覆盖 plan 打标（同事务，行锁串行化）。
    for (const { planId } of planRows) {
      await setReviewFlag(tx, { targetType: 'plan', targetId: planId }, reason);
    }
    return { outcome: 'changed', flaggedPlans: planRows.length } as const;
  });
}
