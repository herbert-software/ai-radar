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
import { eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiNewsEvents } from '../../db/schema.js';
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

/** 批量评分结果（供编排组做阶段熔断：分母 = scored + degraded = 本轮送判数）。 */
export interface ScoreEventsResult {
  /** 本轮实际送判（未评分）的事件数 = 阶段熔断分母。 */
  judged: number;
  /** 成功写分的事件数。 */
  scored: number;
  /** 单条降级（judge 失败）被跳过、未写库的事件数。 */
  degradedCount: number;
}

export interface ScoreEventsOptions {
  /** 透传给 judgeRawItem 的选项（如注入 mock generateObjectFn、maxAttempts）。 */
  judge?: JudgeOptions;
  /** 错误日志 sink，默认 console.error；便于测试断言降级被记录（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
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

  // 只送判尚未评分的事件：importance_score IS NULL 即「未被本 Agent 写过分」。
  // 其余 *_score 列与 importance_score 同生同灭（同一次 UPDATE 一并写），故以它为准即可。
  const events: UnscoredEvent[] = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
    })
    .from(aiNewsEvents)
    .where(isNull(aiNewsEvents.importanceScore));

  let scored = 0;
  let degradedCount = 0;

  for (const [index, event] of events.entries()) {
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
      await dbh
        .update(aiNewsEvents)
        .set({
          importanceScore: scoreColumns.importanceScore,
          noveltyScore: scoreColumns.noveltyScore,
          developerRelevanceScore: scoreColumns.developerRelevanceScore,
          hypeRiskScore: scoreColumns.hypeRiskScore,
          shouldPush: scoreColumns.shouldPush,
        })
        .where(eq(aiNewsEvents.eventId, event.eventId));

      scored += 1;
    } catch (error) {
      if (error instanceof ValueJudgeFailureError) {
        // 单条降级：跳过 + 记日志 + 计数，整批继续，不写未校验数据。
        degradedCount += 1;
        logError(
          `事件 ${event.eventId} 价值判断降级（跳过，不写库）`,
          error,
        );
        continue;
      }
      // 非降级类错误（如 DB 写入失败）不应被吞——同样计入降级并记录，但不中断整批，
      // 让编排组据 degradedCount 决定是否熔断。
      degradedCount += 1;
      logError(`事件 ${event.eventId} 评分写库异常（跳过）`, error);
    }
  }

  return { judged: events.length, scored, degradedCount };
}
