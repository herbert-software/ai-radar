/**
 * Top N 组合分选择（daily-intel-pipeline 8.1 / 8.2，design D5）。
 *
 * 由**程序**（非 LLM）从候选事件中选出每日 Top N。职责切分：Value Judge 的
 * should_push 与各项 score 只产生**候选信号**；本模块按确定性组合分排序取 Top N。
 *
 * 关键不变量（绝不可违背）：
 * - 候选窗口三条件齐：`should_push=true`
 *   AND `first_seen_at 在近 N 天`
 *   AND `该 event 从未被任何 push_date 以该 channel success 推送过`（跨天/跨次不重推，
 *   常青高分事件一生只成功推一次）。
 * - 候选窗口「今天」必须复用 push-date.ts 的同一 Asia/Shanghai 时间源（getPushDate），
 *   禁止另起一套时区计算导致两处口径漂移（design D5/D6）。
 * - 组合分 `rank_score = 0.45*importance + 0.25*developer_relevance + 0.20*novelty
 *   − 0.10*hype_risk`，权重读 config（env.RANK_WEIGHT_*），hype_risk 为减项。
 * - 确定性 tiebreaker：`published_at DESC NULLS LAST, event_id ASC`——保证对同一批
 *   已落库事件多次运行结果一致（event_id 一经塌缩首建即固定、不随 UPDATE 变化）。
 * - importance 下限闸（env.IMPORTANCE_FLOOR）：低于阈值不入选，宁可少于 N 条也不凑数。
 * - 排序与名单由程序定，**不交给 LLM**。
 */
import { and, eq, gte, notExists, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, pushRecords } from '../db/schema.js';
import { env } from '../config/env.js';
import { startOfDayInTimeZone } from '../push/push-date.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 推送通道（本期仅 telegram 单通道）。 */
const CHANNEL = 'telegram';

/** 候选/入选事件的最小视图（供 dispatcher 拼消息 + 排序）。 */
export interface SelectedEvent {
  eventId: string;
  representativeTitle: string | null;
  summaryZh: string | null;
  /** 一句话要点（digest 产出，落库 ai_news_events.headline_zh；旧事件/降级为 null，渲染走回退）。 */
  headlineZh: string | null;
  /**
   * 代表 raw_item 的 canonical_url（原文可点击链接）。selectTopN 不 join raw_items，
   * 故在此恒置 null 占位，由 run-daily 用 loadCanonicalUrls map 覆盖填实值。
   */
  canonicalUrl: string | null;
  publishedAt: Date | null;
  /** 程序计算的组合分（保留供可观测/日志，不入库）。 */
  rankScore: number;
}

/** Top N 选择的可注入参数。 */
export interface SelectTopNOptions {
  /** 参考时刻，决定候选窗口「今天」与近 N 天下界（默认当前时刻）。 */
  now?: Date;
  /** 覆盖 Top N 条数（默认 env.TOP_N）。 */
  topN?: number;
  /** 覆盖 importance 下限闸（默认 env.IMPORTANCE_FLOOR）。 */
  importanceFloor?: number;
  /** 覆盖近 N 天窗口（默认 env.FIRST_SEEN_WINDOW_DAYS）。 */
  windowDays?: number;
  /** 覆盖组合分权重（默认 env.RANK_WEIGHT_*）。 */
  weights?: RankWeights;
}

/** 组合分权重（hype 为减项的非负幅度）。 */
export interface RankWeights {
  importance: number;
  developerRelevance: number;
  novelty: number;
  /** hype_risk 减项幅度（rank_score 里以负权重计）。 */
  hypeRisk: number;
}

function defaultWeights(): RankWeights {
  return {
    importance: env.RANK_WEIGHT_IMPORTANCE,
    developerRelevance: env.RANK_WEIGHT_DEVELOPER_RELEVANCE,
    novelty: env.RANK_WEIGHT_NOVELTY,
    hypeRisk: env.RANK_WEIGHT_HYPE_RISK,
  };
}

/** NUMERIC 列经 Drizzle 读回为字符串，统一转 number；NULL → 0（缺分按 0 计，不入选靠下限闸）。 */
function toNum(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 组合分 = 0.45*importance + 0.25*developer_relevance + 0.20*novelty − 0.10*hype_risk
 * （权重读 config）。
 */
export function computeRankScore(
  scores: {
    importance: number;
    developerRelevance: number;
    novelty: number;
    hypeRisk: number;
  },
  weights: RankWeights,
): number {
  return (
    weights.importance * scores.importance +
    weights.developerRelevance * scores.developerRelevance +
    weights.novelty * scores.novelty -
    weights.hypeRisk * scores.hypeRisk
  );
}

/**
 * 候选窗口下界：「今天（Asia/Shanghai）」往前推 (windowDays − 1) 个自然日的 00:00（上海时间），
 * 换算成 UTC 时刻作为 `first_seen_at >=` 下界。
 *
 * 复用 push-date 的同一时区源（startOfDayInTimeZone），保证窗口「今天」与 push_date 不漂移
 * （design D5/D6）。「近 N 天」= 含今天在内的连续 N 个上海自然日（windowDays=1 即仅今天）。
 */
function windowLowerBound(now: Date, windowDays: number): Date {
  return startOfDayInTimeZone(now, windowDays - 1);
}

/**
 * 比较器：rank_score DESC，tiebreaker `published_at DESC NULLS LAST, event_id ASC`。
 * 确定性——对同一批已落库事件多次运行结果一致。
 */
export function compareForTopN(a: SelectedEvent, b: SelectedEvent): number {
  if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore; // DESC
  // published_at DESC NULLS LAST：非空优先，时间晚者优先。
  const at = a.publishedAt ? a.publishedAt.getTime() : null;
  const bt = b.publishedAt ? b.publishedAt.getTime() : null;
  if (at !== bt) {
    if (at === null) return 1; // a 为 NULL → 排后
    if (bt === null) return -1; // b 为 NULL → 排后
    return bt - at; // DESC
  }
  // 最终 tiebreaker：event_id ASC（字典序）——稳定 surrogate UUID 保证可复现。
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * 对已构造好 rankScore 的候选做确定性排序并取前 N（纯函数，无副作用）。
 *
 * 不修改入参数组（先复制再排序），保证对同一批输入多次调用结果一致——这是
 * 「Top N 边界可复现」的可单测保证。候选窗口过滤（should_push / 近 N 天 / 下限闸 /
 * 从未 success）由 selectTopN 在 SQL 层完成，本函数只负责确定性排序与截断。
 */
export function rankAndSelect(
  candidates: readonly SelectedEvent[],
  topN: number,
): SelectedEvent[] {
  return [...candidates].sort(compareForTopN).slice(0, topN);
}

/**
 * 查询今日候选并按组合分确定性取 Top N。
 *
 * 候选窗口（全在 SQL 层用程序条件表达，无 LLM 参与）：
 *   should_push = true
 *   AND first_seen_at >= 今天（上海）往前第 (windowDays−1) 个自然日的 00:00（上海，换算为 UTC）
 *   AND importance_score >= importanceFloor   ← 下限闸
 *   AND NOT EXISTS (push_records success for this event/channel on any push_date)
 *
 * 排序与取前 N 在程序内完成（compareForTopN），保证确定性 tiebreaker。
 *
 * @param options 可注入 now / topN / 阈值 / 权重（默认读 env）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function selectTopN(
  options: SelectTopNOptions = {},
  dbh: DbLike = defaultDb,
): Promise<SelectedEvent[]> {
  const now = options.now ?? new Date();
  const topN = options.topN ?? env.TOP_N;
  const importanceFloor = options.importanceFloor ?? env.IMPORTANCE_FLOOR;
  const windowDays = options.windowDays ?? env.FIRST_SEEN_WINDOW_DAYS;
  const weights = options.weights ?? defaultWeights();

  // 「今天」与 push_date 同源：windowLowerBound 经 startOfDayInTimeZone 复用 push-date 的
  // Asia/Shanghai 时区源，下界 = 今天往前第 (windowDays−1) 个上海自然日的 00:00（防口径漂移）。
  const lowerBound = windowLowerBound(now, windowDays);

  // 「从未被任何 push_date 以该 channel success 推送过」用相关子查询 NOT EXISTS 表达——
  // 跨天/跨次不重推（design D5）。注意是「从未 success」而非「今天未 success」。
  const neverSuccessfullyPushed = notExists(
    dbh
      .select({ one: sql`1` })
      .from(pushRecords)
      .where(
        and(
          eq(pushRecords.targetType, 'event'),
          eq(pushRecords.targetId, aiNewsEvents.eventId),
          eq(pushRecords.channel, CHANNEL),
          eq(pushRecords.status, 'success'),
        ),
      ),
  );

  const rows = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      summaryZh: aiNewsEvents.summaryZh,
      headlineZh: aiNewsEvents.headlineZh,
      publishedAt: aiNewsEvents.publishedAt,
      importanceScore: aiNewsEvents.importanceScore,
      noveltyScore: aiNewsEvents.noveltyScore,
      developerRelevanceScore: aiNewsEvents.developerRelevanceScore,
      hypeRiskScore: aiNewsEvents.hypeRiskScore,
    })
    .from(aiNewsEvents)
    .where(
      and(
        eq(aiNewsEvents.shouldPush, true),
        // first_seen_at 非空且在近 N 天内（恒 NULL 的 first_seen_at 不入候选）。
        gte(aiNewsEvents.firstSeenAt, lowerBound),
        // importance 下限闸：低于阈值不入选（宁缺勿凑）。NULL importance 被 gte 自然排除。
        gte(aiNewsEvents.importanceScore, String(importanceFloor)),
        neverSuccessfullyPushed,
      ),
    );

  const candidates: SelectedEvent[] = rows.map((r) => ({
    eventId: r.eventId,
    representativeTitle: r.representativeTitle,
    summaryZh: r.summaryZh,
    headlineZh: r.headlineZh,
    // canonicalUrl 不在 top-n join，置 null 占位，由 run-daily 用 loadCanonicalUrls 覆盖。
    canonicalUrl: null,
    publishedAt: r.publishedAt,
    rankScore: computeRankScore(
      {
        importance: toNum(r.importanceScore),
        developerRelevance: toNum(r.developerRelevanceScore),
        novelty: toNum(r.noveltyScore),
        hypeRisk: toNum(r.hypeRiskScore),
      },
      weights,
    ),
  }));

  return rankAndSelect(candidates, topN);
}
