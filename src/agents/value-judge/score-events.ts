/**
 * Value Judge 接入流水线（任务 6.1 / 6.2，value-judge-agent MODIFIED）。
 *
 * 把 P0 的 seed 落库脚手架替换为：对去重塌缩后的**真实事件**逐条调用 `judgeRawItem`，
 * 按 ./mapping.ts 的字段名映射写入 ai_news_events 的 *_score 列与 should_push。
 *
 * 关键不变量（spec「Agent 输出落库往返」/ design D1/D8，逐条照抄到此守住）：
 * - 写分必须 `UPDATE ai_news_events ... WHERE event_id = ?`，`set` 中**仅含**
 *   *_score 与 should_push 列；禁止 `INSERT ... ON CONFLICT` 模板，禁止在 set 带
 *   event_id / representative_raw_item_id / representative_title / first_seen_at /
 *   published_at——否则覆盖塌缩首建的身份/排序列致 Top N 静默退化
 *   （P0 已删的 persistEventScores 全列覆盖式 set 是反面模板）。
 * - judge 阶段**只处理尚未评分的事件**（`importance_score IS NULL`，含本轮塌缩新建
 *   与此前降级未评分者）；已评分事件跳过不重判——避免重复 LLM 调用、避免覆盖旧分。
 * - judgeRawItem 已含重试 + Zod 校验 + 降级抛 ValueJudgeFailureError；单条降级 →
 *   跳过 + 记日志 + degraded_count++，整批继续，**绝不写未校验数据**。
 *
 * 熔断（降级率阈值判断）本身归编排组（G7）：本模块只产出 degraded_count 与逐条容错，
 * 不在此处中止整批。
 */
import { and, eq, isNull, or, lt, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiNewsEvents } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { mapOutputToEventScores } from './mapping.js';
import {
  judgeRawItem,
  ValueJudgeFailureError,
  type JudgeOptions,
} from './index.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 一条待评分事件的最小视图（judge 的 prompt 输入由代表标题构成）。 */
interface UnscoredEvent {
  eventId: string;
  representativeTitle: string | null;
}

/** 批量评分结果（供编排组做阶段熔断：分母 = scored + degraded = 本轮**实际送判**数）。 */
export interface ScoreEventsResult {
  /**
   * 本轮**实际送判**（claim 成功、送 LLM）的事件数 = 阶段熔断分母。
   * **不含** claim 被他人抢走/未过期而跳过者（claimSkipped）——那些事件由对方链路评分，
   * 不属于本链路的「送判」，计入分母会污染降级率（claim 跳过非降级）。
   */
  judged: number;
  /** 成功写分的事件数。 */
  scored: number;
  /** 单条降级（judge 失败）被跳过、未写库的事件数。 */
  degradedCount: number;
  /**
   * 因并发 claim 未抢到（已被另一链路 claim 且未过 T）而跳过的事件数（非降级、不计入熔断分母）。
   * 供可观测：两链路并发时本链路跳过对方正在评分的事件。
   */
  claimSkipped: number;
}

export interface ScoreEventsOptions {
  /** 透传给 judgeRawItem 的选项（如注入 mock generateObjectFn、maxAttempts）。 */
  judge?: JudgeOptions;
  /** 错误日志 sink，默认 console.error；便于测试断言降级被记录（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
  /**
   * 并发评分原子 claim 的回收阈值 T（毫秒，默认 env.JUDGE_CLAIM_RECLAIM_MS）。
   * 一个被 claim 但 *_score 仍 NULL 的事件，停留超过 T 即视为僵尸 claim（崩溃/超时遗留），
   * 可被本链路重新 claim 重评。env 已校验 `T > L + W`（见 config/env.ts superRefine）；
   * 测试可注入小值快速验证「claim 后崩溃经 T 重评」。
   */
  reclaimMs?: number;
}

/** 一次 claim 尝试的结果。 */
export type ClaimResult = 'claimed' | 'skipped';

/**
 * 对单个事件做并发评分原子 claim（送 LLM 前的确定性闸，design D6 / daily-intel「降级逐条容错」）。
 *
 * `UPDATE ai_news_events SET judge_claimed_at = now()
 *    WHERE event_id = ?
 *      AND importance_score IS NULL                                  -- 只 claim 未评分者
 *      AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T ms')  -- 含超时回收
 *  RETURNING event_id`
 *
 * 语义（绝不可违背）：
 * - **只有 RETURNING 返回该行的链路（claim 成功）才送 LLM 评分**；另一并发链路的同一 UPDATE
 *   不满足 `judge_claimed_at IS NULL OR ... < now()-T`（已被对方写过且未过期）→ 0 行返回 → 跳过。
 *   保证「一事件只被评一次分」跨日报/告警两链路成立。
 * - **超时回收**：claim 条件含 `OR judge_claimed_at < now()-T`——claim 后崩溃（judge_claimed_at
 *   非空但 *_score 仍 NULL）的僵尸 claim 经 T 后被重新 claim，不致永久漏评。
 * - `importance_score IS NULL` 与塌缩首建无分态一致（各 *_score 同生同灭），评分成功写分后该事件
 *   不再满足 claim 条件（已有分）——claim 随写分自然失效，无需显式释放。
 *
 * 回收阈值 `T` 由 env 校验满足 `T > L + W`（L=LLM_TIMEOUT_MS、W=JUDGE_WRITE_BUDGET_MS）——使
 * 正在合法评分/写分（停留 < L+W）的事件恒不会存活到 `now()-T`、不被另一链路误回收双评分。
 *
 * @returns 'claimed'（本链路抢到、应送 LLM）/ 'skipped'（已被他人 claim 且未过期、或已评分）。
 */
export async function claimEventForJudging(
  eventId: string,
  reclaimMs: number,
  dbh: DbLike = defaultDb,
): Promise<ClaimResult> {
  // now() - interval 'N milliseconds'：用参数化毫秒数，避免拼接；DB 端时钟统一口径（防进程钟漂）。
  const reclaimCutoff = sql`now() - (${reclaimMs}::double precision * interval '1 millisecond')`;
  const claimed = await dbh
    .update(aiNewsEvents)
    .set({ judgeClaimedAt: sql`now()` })
    .where(
      and(
        eq(aiNewsEvents.eventId, eventId),
        isNull(aiNewsEvents.importanceScore),
        // P3 tombstone 排除（合并核心闭环）：claim CAS 自身 WHERE 必须加 `merged_into IS NULL`——
        // 告警链 scoreUnscoredEvents 不持日报锁，SELECT→claim 分离，间隙日报合并可把本事件置 tombstone
        // （TOCTOU）。仅 SELECT 收口不充分；谓词落 claim CAS 才使「tombstone 绝不被 claim/复活」成立。
        isNull(aiNewsEvents.mergedInto),
        or(
          isNull(aiNewsEvents.judgeClaimedAt),
          lt(aiNewsEvents.judgeClaimedAt, reclaimCutoff),
        ),
      ),
    )
    .returning({ eventId: aiNewsEvents.eventId });

  return claimed.length > 0 ? 'claimed' : 'skipped';
}

/**
 * 释放某事件的评分 claim（清 `judge_claimed_at`，仅当仍未评分时）——评分失败/降级后即时调用，
 * 使下一轮可立即重判，而非等回收阈值 `T`（claim 的超时回收本为「崩溃/超时」兜底；**已处理的
 * 评分失败应主动释放 claim**，否则该事件白白被锁 `T` 时长、也挡住并发链路评分，Bugbot #2）。
 *
 * `WHERE importance_score IS NULL` 守卫：只清「claim 了但没评成功」的，绝不误清已评分事件的痕迹。
 * 释放尽力而为：调用方应吞掉其异常（事件仍会在 `T` 后被超时回收兜底，不致永久漏评）。
 */
export async function releaseJudgeClaim(
  eventId: string,
  dbh: DbLike = defaultDb,
): Promise<void> {
  await dbh
    .update(aiNewsEvents)
    .set({ judgeClaimedAt: null })
    .where(
      and(eq(aiNewsEvents.eventId, eventId), isNull(aiNewsEvents.importanceScore)),
    );
}

/**
 * 对所有「尚未评分」的真实事件逐条评分并写分。
 *
 * 流程：
 * 1. 查 `importance_score IS NULL` 的事件（本轮塌缩新建 + 此前降级未评分者）。
 * 2. 逐条调用 judgeRawItem（代表标题作 prompt 输入）。
 * 3. 成功 → 按 mapping 映射后 `UPDATE ... WHERE event_id = ?`，set 仅含 *_score + should_push。
 * 4. 单条降级（ValueJudgeFailureError）→ 跳过 + 记日志 + degradedCount++，整批继续。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function scoreUnscoredEvents(
  options: ScoreEventsOptions = {},
  dbh: DbLike = defaultDb,
): Promise<ScoreEventsResult> {
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[value-judge] ${message}`, detail));
  const reclaimMs = options.reclaimMs ?? env.JUDGE_CLAIM_RECLAIM_MS;

  // 候选集：尚未评分的事件（importance_score IS NULL 即「未被本 Agent 写过分」）。
  // 这是**候选**而非「已 claim 必送判」——每条送 LLM 前还要逐条原子 claim（claimEventForJudging）；
  // 仅 claim 成功者送判，未抢到（被另一链路 claim 且未过 T）的跳过（claimSkipped++、不计入熔断分母）。
  // 防并发双评分：日报链与告警高频链可能同时 SELECT 到同一未评分事件，靠 claim 而非 SELECT 去重。
  const events: UnscoredEvent[] = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
    })
    .from(aiNewsEvents)
    // P3 tombstone 排除（合并核心闭环）：候选 SELECT 加 `merged_into IS NULL`——被吞 tombstone（评分
    // 前 importance_score 为 NULL）若不排除会被 value-judge 重新选中评分「复活」、进而被 Top N 选中独立
    // 推送，使合并比不合并更糟（spec「tombstone 对所有下游消费者不可见」）。claim/评分写 CAS 另各自加。
    .where(and(isNull(aiNewsEvents.importanceScore), isNull(aiNewsEvents.mergedInto)));

  let scored = 0;
  let degradedCount = 0;
  let judged = 0;
  let claimSkipped = 0;

  for (const [index, event] of events.entries()) {
    // 送 LLM 前原子 claim：仅抢到者送判。未抢到 → 该事件正被另一链路评分（或刚被评完），跳过。
    const claim = await claimEventForJudging(event.eventId, reclaimMs, dbh);
    if (claim === 'skipped') {
      claimSkipped += 1;
      continue;
    }
    judged += 1;
    // 逐条评分进度（轻量，一条一行）：N 次 LLM 调用中间无日志看不出进度。
    console.error(
      `[value-judge] 评分 ${index + 1}/${events.length}（event=${event.eventId.slice(0, 8)}）`,
    );
    try {
      const output = await judgeRawItem(
        {
          // 代表标题为塌缩首建写入的原始 title（NOT NULL 期望，但列可空，兜底空串）。
          title: event.representativeTitle ?? '',
        },
        options.judge,
      );

      const scoreColumns = mapOutputToEventScores(output);

      // 关键不变量：UPDATE ... WHERE event_id = ?，set 仅含 *_score 与 should_push。
      // 绝不带身份/代表/排序列，绝不用 INSERT ON CONFLICT。
      // P3 tombstone 排除（合并核心闭环）：评分写 CAS 自身 WHERE 加 `merged_into IS NULL`——claim 成功
      // 后、评分写前仍存在链内二次 TOCTOU（日报合并可在此间隙把已 claim 的事件置 tombstone）。谓词落
      // 评分写 CAS 才使「tombstone 绝不被写 *_score/should_push 复活」成立（命中 0 行=无害空写、跳过）。
      const updated = await dbh
        .update(aiNewsEvents)
        .set({
          importanceScore: scoreColumns.importanceScore,
          noveltyScore: scoreColumns.noveltyScore,
          developerRelevanceScore: scoreColumns.developerRelevanceScore,
          hypeRiskScore: scoreColumns.hypeRiskScore,
          shouldPush: scoreColumns.shouldPush,
        })
        .where(and(eq(aiNewsEvents.eventId, event.eventId), isNull(aiNewsEvents.mergedInto)))
        .returning({ eventId: aiNewsEvents.eventId });

      if (updated.length === 0) {
        // 评分写命中 0 行：claim 成功后、写入前该事件被并发日报合并置 tombstone（链内二次 TOCTOU，
        // 仅「告警链评分」与「日报链语义合并」并发时可能发生；日报链自身合并在 value-judge 之前、
        // 候选 SELECT 已排除 tombstone，故不触发）。这既非评分成功、也非 LLM 降级，而是 tombstone 被
        // 正确排除——故**不计 scored、并从熔断分母剔除**（judged--，避免用一条非降级的 tombstone 稀释
        // 降级率），同时释放该（已 tombstone）事件的 claim（防残留 judge_claimed_at；该事件已被候选
        // SELECT 的 `merged_into IS NULL` 永久排除，释放仅作纵深清理）。
        judged -= 1;
        await releaseJudgeClaim(event.eventId, dbh).catch((releaseErr: unknown) =>
          logError(
            `事件 ${event.eventId} 评分写命中 0 行（已 tombstone）释放 claim 失败（候选已排除，无副作用）`,
            releaseErr,
          ),
        );
        logError(
          `事件 ${event.eventId} 评分写命中 0 行（claim 后被并发合并置 tombstone）：跳过，不计入 scored/熔断分母`,
          null,
        );
        continue;
      }

      scored += 1;
    } catch (error) {
      // 评分失败（降级或写库异常）：**立即释放 claim**（清 judge_claimed_at），使下一轮可即时
      // 重判，而非白等回收阈值 T（Bugbot #2）。释放尽力而为——失败不再拖垮整批（事件仍会在 T
      // 后被超时回收兜底，不致永久漏评）。
      await releaseJudgeClaim(event.eventId, dbh).catch((releaseErr: unknown) =>
        logError(
          `事件 ${event.eventId} 释放 judge claim 失败（将由超时回收 T 兜底）`,
          releaseErr,
        ),
      );
      if (error instanceof ValueJudgeFailureError) {
        // 单条降级：跳过 + 记日志 + 计数，整批继续，不写未校验数据。
        degradedCount += 1;
        logError(
          `事件 ${event.eventId} 价值判断降级（跳过，不写库，已释放 claim）`,
          error,
        );
        continue;
      }
      // 非降级类错误（如 DB 写入失败）不应被吞——同样计入降级并记录，但不中断整批，
      // 让编排组据 degradedCount 决定是否熔断。
      degradedCount += 1;
      logError(`事件 ${event.eventId} 评分写库异常（跳过，已释放 claim）`, error);
    }
  }

  // judged = 本链路实际 claim 成功并送判的数（熔断分母）；claimSkipped 不计入分母（非降级）。
  return { judged, scored, degradedCount, claimSkipped };
}
