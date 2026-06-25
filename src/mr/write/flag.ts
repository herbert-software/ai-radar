/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）待复核标写原语（task 2.2，design D5/D6）。
 *
 * 抓取链/事件消费者/陈旧度排程**唯一可 import 的写入口**——只能打/翻/解标，**结构上改不了 `mr_*` 事实**。
 * 故本文件**绝不 import `src/mr/ingest/`**（`upsert*` + `recordPriceChange` 事实 writer）；这条纪律由
 * task 2.3 的 eslint `no-restricted-imports` 兜底（本组只负责不引入违例 import）。
 *
 * 写契约（schema.ts:675-678 已给 SQL）：
 * - 打/翻标 = **单语句 CAS**：`INSERT … ON CONFLICT(target_type,target_id)
 *    DO UPDATE SET status='pending', reason=excluded.reason, opened_at=now(), resolved_at=NULL`。
 *    **无 setWhere**（区别于 `kb/store.ts` 守 terminal success）——pending 时也刷 reason，resolved 后重开是
 *    预期，`opened_at` 重置为 now 是单行可变标的有意行为（design D5）。
 *    幂等收敛单行：事件/指纹/陈旧度多路并发命中同 target 自然合并为一行（不做「写前查 status」预检——
 *    那是 read-then-write TOCTOU 会与人工 resolve 竞态丢真实触发，design D8）。
 * - 解标 = plain `UPDATE status='resolved', resolved_at=now()`（design D6）。
 *
 * Zod 闸（spec「非录入路径写枚举列也过 Zod」）：写前过 `mrReviewFlagTargetTypeSchema`（多态 target_type
 * 是有限值列，事件/指纹经此 helper 写也须过闸）+ `mrReviewFlagStatusSchema`（写入的状态字面亦过闸）。
 *
 * 签名收 `dbh: DbLike | TxLike`（仿 `kb/store.ts` 的 `claimRecord`），使打标可在事务内复用——
 * `recordPriceChange` 的同刻冲突分支、staleness 排程可在已持锁的同事务里打标，行锁串行化并发翻标。
 */
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrReviewFlag } from '../../db/schema.js';
import {
  mrReviewFlagStatusSchema,
  mrReviewFlagTargetTypeSchema,
} from '../../db/mr-schema.zod.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测（对齐 kb/store.ts）。 */
type DbLike = typeof defaultDb;

/** 事务句柄类型（DbLike.transaction 回调入参），使写标可在事务内复用（行锁保持到提交）。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/** flag 状态字面（与 mrReviewFlagStatusSchema 取值一致）。 */
const STATUS_PENDING = 'pending';
const STATUS_RESOLVED = 'resolved';

/** 标的（多态引 plan/source/vendor 三身份表 PK）。 */
export interface ReviewFlagTarget {
  /** ∈ {plan, source, vendor}（过 mrReviewFlagTargetTypeSchema）。 */
  targetType: string;
  /** 对应身份表 PK（varchar(128)）。 */
  targetId: string;
}

/**
 * 打/翻标（单语句 CAS，无 setWhere，design D5）。已存在则翻回 pending 并刷 reason/opened_at、清 resolved_at；
 * 不存在则新建 pending 行。幂等收敛单行（并发命中同 target 被该行锁串行化）。
 *
 * @param dbh db 实例或已开事务句柄（事务内调用使打标与持锁的改价/陈旧度同事务）。
 * @param target 标的（target_type 过 Zod 枚举闸）。
 * @param reason 触发原因（nullable；翻标时刷新为本次原因）。
 */
export async function setReviewFlag(
  dbh: DbLike | TxLike,
  target: ReviewFlagTarget,
  reason: string | null,
): Promise<void> {
  // 写前过 Zod：target_type 与写入的 status 字面均是有限值列，发 SQL 前拒非法（spec「非录入路径写枚举列也过 Zod」）。
  const targetType = mrReviewFlagTargetTypeSchema.parse(target.targetType);
  const status = mrReviewFlagStatusSchema.parse(STATUS_PENDING);

  await dbh
    .insert(mrReviewFlag)
    .values({
      targetType,
      targetId: target.targetId,
      reason,
      status,
      openedAt: sql`now()`,
      resolvedAt: null,
    })
    .onConflictDoUpdate({
      target: [mrReviewFlag.targetType, mrReviewFlag.targetId],
      // ⚠️ 无 setWhere（design D5）：pending 时也刷 reason、resolved 后翻回 pending、opened_at 重置 now。
      // 与 kb/store.ts 守 terminal success 的 setWhere 相反——单行可变标的重开是有意行为。
      set: {
        status,
        reason: sql`excluded.reason`,
        openedAt: sql`now()`,
        resolvedAt: null,
      },
    });
}

/**
 * 解标（plain UPDATE，design D6）。仅置 status='resolved' + resolved_at=now()，不动 opened_at/reason。
 * 缺标的行时 UPDATE 命中 0 行（幂等，无报错）。
 *
 * @param dbh db 实例或已开事务句柄（dispose 面 markChecked 在同事务里 resolve + 刷 last_checked）。
 */
export async function resolveFlag(
  dbh: DbLike | TxLike,
  target: ReviewFlagTarget,
): Promise<void> {
  // 写前过 Zod：写入的 status 字面 + target_type 均过有限值闸。
  const targetType = mrReviewFlagTargetTypeSchema.parse(target.targetType);
  const status = mrReviewFlagStatusSchema.parse(STATUS_RESOLVED);

  await dbh
    .update(mrReviewFlag)
    .set({ status, resolvedAt: sql`now()` })
    .where(
      and(
        eq(mrReviewFlag.targetType, targetType),
        eq(mrReviewFlag.targetId, target.targetId),
      ),
    );
}
