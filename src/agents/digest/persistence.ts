/**
 * 中文摘要落库与降级回退（任务 7.2，capability: chinese-digest-agent）。
 *
 * 关键不变量（绝不可违背）：
 * - 写 summary_zh 必须 `UPDATE ai_news_events ... WHERE event_id = ?`，`set` 中**仅含**
 *   summary_zh；禁止 `INSERT ... ON CONFLICT` 模板；禁止覆盖塌缩首建写入的
 *   representative_title / representative_raw_item_id / first_seen_at / published_at / *_score 列。
 * - 只在 Agent 输出经 Zod 校验通过后才落库（写入的是 digestOutputSchema.summary_zh），
 *   绝不写未校验或半截输出。
 * - 摘要降级时回退使用塌缩首建写入的 representative_title（非 NULL；极个别为空串时
 *   再兜底到 canonical_url），或把该 event 剔除出当日日报——绝不把未校验内容推给用户
 *   或写入 summary_zh。
 *
 * 边界：本模块只负责单条事件「摘要 → 校验 → 落库 / 降级回退」的编排，
 *   不实现 Top N / 推送 / BullMQ 编排 / 降级率熔断（别组）。
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiNewsEvents } from '../../db/schema.js';
import {
  summarizeEvent,
  DigestFailureError,
  type SummarizeEventInput,
  type SummarizeOptions,
} from './index.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入 / 集成测。 */
type DbLike = typeof defaultDb;

/** 待摘要事件的最小视图（由 Top N 选择产出后传入，或集成测 seed）。 */
export interface EventForDigest {
  /** ai_news_events.event_id（不透明 surrogate key），UPDATE 的定位键。 */
  eventId: string;
  /** 事件代表标题（塌缩首建写入，非 NULL；摘要降级时回退展示）。 */
  representativeTitle: string | null;
  /** 代表 raw_item 的 canonical_url（representative_title 极个别为空串时的兜底）。 */
  canonicalUrl?: string | null;
  /** 事件正文/原文摘要（可选，供 Agent 上下文）。 */
  content?: string | null;
  /** 来源标识（可选，供 Agent 上下文）。 */
  source?: string | null;
}

/** 单条事件摘要处理结果（供上层统计 / 降级率熔断 / 推送渲染）。 */
export type DigestOutcome =
  | {
      eventId: string;
      /** 摘要成功并已 UPDATE 落库。 */
      status: 'summarized';
      /** 经校验、已落库的中文摘要正文。 */
      summaryZh: string;
      /**
       * 经校验、已落库的一句话要点（供 run-daily 本轮新摘要分支按 `status==='summarized'`
       * 收窄后取值透传给日报渲染）。仅 summarized 变体有此字段：fallback/dropped 无要点，
       * 故不加（加了会破坏 run-daily 按 status 收窄取值的语义）。
       */
      headlineZh: string;
      degraded: false;
    }
  | {
      eventId: string;
      /** 摘要降级：回退用 representative_title / canonical_url 作展示文本，未写 summary_zh。 */
      status: 'fallback';
      /** 推送时应展示的回退文本（representative_title 或兜底 canonical_url）。 */
      fallbackText: string;
      degraded: true;
    }
  | {
      eventId: string;
      /** 摘要降级且无任何可展示文本（标题为空且无 URL）→ 剔除出当日日报。 */
      status: 'dropped';
      degraded: true;
    };

/**
 * 仅写 summary_zh + headline_zh：
 * `UPDATE ai_news_events SET summary_zh = ?, headline_zh = ? WHERE event_id = ?`。
 *
 * set 中**仅含** summary_zh 与 headline_zh，绝不触碰身份 / 代表 / 时间 / 评分列
 * （event_id / representative_* / first_seen_at / published_at / *_score）；
 * 绝不用 INSERT ... ON CONFLICT。仅在摘要经 Zod 校验通过后调用。
 */
async function updateSummaryZh(
  dbh: DbLike,
  eventId: string,
  summaryZh: string,
  headlineZh: string,
): Promise<void> {
  await dbh
    .update(aiNewsEvents)
    .set({ summaryZh, headlineZh })
    .where(eq(aiNewsEvents.eventId, eventId));
}

/**
 * 计算摘要降级时的回退展示文本。
 *
 * 优先 representative_title（塌缩首建写入、非 NULL）；
 * 极个别为空串 / 仅空白时兜底到 canonical_url；
 * 两者皆无可用文本 → 返回 null（调用方据此剔除该 event 出当日日报）。
 */
function resolveFallbackText(event: EventForDigest): string | null {
  const title = event.representativeTitle?.trim();
  if (title) return title;
  const url = event.canonicalUrl?.trim();
  if (url) return url;
  return null;
}

/**
 * 对一条入选事件生成中文摘要并落库；失败则降级，绝不写半截输出。
 *
 * 成功路径：summarizeEvent 产出经校验的 summary_zh → `UPDATE ... SET summary_zh`
 *   → 返回 status='summarized'。
 * 降级路径（summarizeEvent 抛 DigestFailureError，已记日志、已重试耗尽）：
 *   - representative_title（或兜底 canonical_url）可用 → status='fallback'，不写 summary_zh；
 *   - 皆不可用 → status='dropped'，剔除该 event 出当日日报。
 *
 * 注意：降级路径**不写** summary_zh（保持 NULL），故推送层绝不会读到未校验内容；
 * 推送层应优先用 summary_zh，无则用本结果的 fallbackText。
 */
export async function digestEvent(
  event: EventForDigest,
  options: SummarizeOptions = {},
  dbh: DbLike = defaultDb,
): Promise<DigestOutcome> {
  const title = event.representativeTitle?.trim() ?? '';
  const input: SummarizeEventInput = {
    // representativeTitle 极个别为空串时用 canonicalUrl 占位作 prompt 主体，
    // 仅影响 prompt 上下文，不影响落库与降级判定。
    title: title || event.canonicalUrl?.trim() || '(无标题)',
    content: event.content ?? null,
    source: event.source ?? null,
  };

  try {
    const output = await summarizeEvent(input, options);
    // output.summary_zh / headline_zh 已经 Zod 校验（非空），落库仅写此两列。
    await updateSummaryZh(
      dbh,
      event.eventId,
      output.summary_zh,
      output.headline_zh,
    );
    return {
      eventId: event.eventId,
      status: 'summarized',
      summaryZh: output.summary_zh,
      headlineZh: output.headline_zh,
      degraded: false,
    };
  } catch (error) {
    if (!(error instanceof DigestFailureError)) {
      // 非预期错误（如 DB 连接断开）：不静默吞掉，向上抛由编排层处理。
      throw error;
    }
    // 降级：绝不写 summary_zh（保持 NULL）。回退展示文本或剔除该 event。
    const fallbackText = resolveFallbackText(event);
    if (fallbackText !== null) {
      return {
        eventId: event.eventId,
        status: 'fallback',
        fallbackText,
        degraded: true,
      };
    }
    return { eventId: event.eventId, status: 'dropped', degraded: true };
  }
}
