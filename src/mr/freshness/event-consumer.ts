/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）ai-radar 事件流触发复核消费者
 * （task 4.2/4.3，design D8 / spec「ai-radar 事件流触发复核」）。
 *
 * 纯业务函数 `runEventReview`（队列四件套见 ./event-review-queue.ts，worker 只 await 它）：
 *   只读扫近窗 `ai_news_events` → 命中被跟踪厂商 + 价格/模型关键词 → 给该厂商 plan 经 A 的
 *   `setReviewFlag` 单语句 CAS 打标。**只写 flag、绝不改 `mr_*` 事实**。
 *
 * 结构守卫（design D7，eslint `event-consumer*` no-restricted-imports 兜底）：
 * 本文件**只 import `src/mr/write/`（setReviewFlag）**，**禁 import `src/mr/ingest/`** 事实 writer。
 * 读 `ai_news_events`/`mr_vendors`/`mr_plans` 是只读查询（非 import writer），允许。
 *
 * 关键不变量（绝不可违背，design D8）：
 * - 候选门 = **闭区间** `startOfDayInTimeZone(now, windowDays-1) <= published_at <= now`：
 *   **下界**防冷启动/回填批量误打标；**上界 `<= now` 绝不可省**——拦 AI 推断的未来 `published_at`
 *   越过下界刷屏。`published_at` nullable，`gte/lte` 对 NULL 返 false → 无日期事件自然排除。
 *   `windowDays` 由 env `positive()` 保证 `>=1`（0 会令下界算成明天致空集静默停打标，env 已拒，本文件不再校验）。
 * - **排除 `merged_into IS NOT NULL` tombstone**（合并掉的死 event 不触发复核）。
 * - 匹配 = `mr_vendors.normalized_name`（已小写归一）vs 事件 `representative_title/summary_zh/headline_zh`
 *   （**三列均 nullable，任一为 NULL 跳过该列、不对 NULL 归一/拼接**，两侧归一）+ 价格/模型关键词常量。
 * - 命中 → 给该厂商 plan 经单语句 CAS 打标，**不做「写前查 status」预检**（CAS 本就幂等收敛单行，
 *   预检是 read-then-write TOCTOU 会与人工 resolve 竞态丢真实事件）。
 * - 多 plan 打标 **per-target 独立**（每 CAS 自治 autocommit，失败隔离、不裹批事务）。
 */
import { and, gte, isNull, lte, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiNewsEvents, mrPlans, mrVendors } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { startOfDayInTimeZone } from '../../push/push-date.js';
import { setReviewFlag } from '../write/flag.js';

type DbLike = typeof defaultDb;

/**
 * 价格 / 模型变动触发复核的关键词（**校准旋钮**：误召只多打标无害，漏召由 D9 全表陈旧度兜底）。
 *
 * 含中英常见表述（事件中英混排）。匹配为归一后子串：英文走小写折叠，中文逐字命中。
 * 增删关键词只影响召回率、不改正确性；PR 评审校准。
 */
export const REVIEW_TRIGGER_KEYWORDS: readonly string[] = [
  // 价格 / 计费
  'price', 'pricing', 'cost', 'subscription', 'plan', 'tier', 'quota', 'credit',
  'token', 'billing', 'discount', 'free tier', 'rate limit',
  '价格', '涨价', '降价', '调价', '计费', '订阅', '套餐', '额度', '配额', '免费', '收费', '限额', '限速',
  // 模型 / 发布
  'model', 'release', 'launch', 'available', 'deprecat', 'sunset', 'context window',
  '模型', '发布', '上线', '下线', '弃用', '停用', '上下文',
];

/** 单条命中事件的最小视图（只读扫描列）。 */
interface CandidateEvent {
  eventId: string;
  representativeTitle: string | null;
  summaryZh: string | null;
  headlineZh: string | null;
}

/** 被跟踪厂商最小视图（用于命中匹配 + 反查其 plan）。 */
interface VendorRow {
  id: string;
  normalizedName: string;
}

export interface RunEventReviewOptions {
  /** 参考时刻（决定候选闭区间上界与下界；默认当前时刻）。 */
  now?: Date;
  /** 注入 db 句柄（默认全局 db；测试注入桩使无需真实 DB）。 */
  db?: DbLike;
  /** 候选窗口天数（默认 env.MR_EVENT_REVIEW_WINDOW_DAYS，env 已保证 `>=1`）。 */
  windowDays?: number;
  /** 运行期日志 sink（默认 console.error）。 */
  log?: (message: string, detail?: unknown) => void;
}

export interface RunEventReviewResult {
  /** 候选门内的非-tombstone 事件数（闭区间内）。 */
  scanned: number;
  /** 命中（被跟踪厂商 + 关键词）的事件数。 */
  matchedEvents: number;
  /** 实际打标的 plan 数（per-target CAS 成功计；失败隔离不计）。 */
  flaggedPlans: number;
}

const defaultLog = (message: string, detail?: unknown): void =>
  console.error(`[mr-event-review] ${message}`, detail ?? '');

/**
 * 归一文本供匹配：小写折叠 + 折叠连续空白 + 去首尾空白。
 * 与 `mr_vendors.normalized_name`（录入时 `.toLowerCase().trim()`）同口径，使两侧可子串命中。
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 判断事件是否命中：归一后的事件文本须同时含**某被跟踪厂商名** + **某价格/模型关键词**。
 *
 * 三列 nullable：**任一为 NULL 跳过该列、不对 NULL 归一**；全 NULL → 无可匹配文本 → 不命中。
 * 返回命中的 vendors（用于逐个反查其 plan）；无命中返回空数组。
 */
function matchVendor(event: CandidateEvent, vendors: VendorRow[]): VendorRow[] {
  // 仅取非 NULL 文本列，逐列归一后拼成一段可匹配文本（NULL 列绝不参与，避免 'null' 字面误匹配）。
  const parts = [event.representativeTitle, event.summaryZh, event.headlineZh]
    .filter((t): t is string => t !== null && t !== '')
    .map(normalizeForMatch);
  if (parts.length === 0) return [];
  const haystack = parts.join(' ');

  const hasKeyword = REVIEW_TRIGGER_KEYWORDS.some((kw) =>
    haystack.includes(normalizeForMatch(kw)),
  );
  if (!hasKeyword) return [];

  // 厂商名已小写归一（录入契约）；子串命中（normalized_name 短，子串足够，不引词边界库）。
  return vendors.filter((v) => v.normalizedName !== '' && haystack.includes(v.normalizedName));
}

/**
 * 跑一次事件流触发复核（纯顺序、只读扫描 + per-target CAS 打标）。
 *
 * @param options 注入点（now / db 桩 / windowDays / log）。
 */
export async function runEventReview(
  options: RunEventReviewOptions = {},
): Promise<RunEventReviewResult> {
  const now = options.now ?? new Date();
  const dbh = options.db ?? defaultDb;
  const windowDays = options.windowDays ?? env.MR_EVENT_REVIEW_WINDOW_DAYS;
  const log = options.log ?? defaultLog;

  // 候选闭区间下界（windowDays 已由 env `positive()` 保证 >=1，此处不再校验）。
  const lowerBound = startOfDayInTimeZone(now, windowDays - 1);

  // ── 只读扫候选事件：闭区间 published_at + 排 tombstone。
  // 下界 gte(NULL)→false、上界 lte(NULL)→false：nullable published_at 自然排除（D8 明确接受）。
  // 上界 `<= now` 绝不可省——拦 AI 推断的未来 published_at 越过下界刷屏。
  const events: CandidateEvent[] = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      summaryZh: aiNewsEvents.summaryZh,
      headlineZh: aiNewsEvents.headlineZh,
    })
    .from(aiNewsEvents)
    .where(
      and(
        gte(aiNewsEvents.publishedAt, lowerBound),
        lte(aiNewsEvents.publishedAt, now),
        isNull(aiNewsEvents.mergedInto),
      ),
    );

  // ── 被跟踪厂商全集（低百行，整表读；normalized_name 已小写归一）。
  const vendors: VendorRow[] = await dbh
    .select({ id: mrVendors.id, normalizedName: mrVendors.normalizedName })
    .from(mrVendors);

  let matchedEvents = 0;
  let flaggedPlans = 0;

  for (const event of events) {
    const matchedVendors = matchVendor(event, vendors);
    if (matchedVendors.length === 0) continue;
    matchedEvents += 1;

    for (const vendor of matchedVendors) {
      // 反查该厂商全部 plan（只读）。
      const plans = await dbh
        .select({ id: mrPlans.id })
        .from(mrPlans)
        .where(sql`${mrPlans.vendorId} = ${vendor.id}`);

      const reason = `event-review: ai-radar 事件 ${event.eventId} 命中厂商 ${vendor.normalizedName}（价格/模型关键词）`;

      // per-target 独立打标：每 CAS 自治 autocommit，失败隔离、不裹批事务（D8）。
      for (const plan of plans) {
        try {
          // ponytail: window-overlap re-trigger — events within windowDays (default 1d) re-call setReviewFlag
          // each replay may re-open an already-resolved plan. Acceptable: windowDays is bounded + single-writer.
          // Per-event/per-plan watermark dedup deferred to 5c. With #20 generation-aware resolveFlag,
          // the resolve side won't lose signal; only re-flag friction remains.
          await setReviewFlag(dbh, { targetType: 'plan', targetId: plan.id }, reason);
          flaggedPlans += 1;
        } catch (error) {
          // 单 plan 打标失败隔离，不拖垮同事件其余 plan / 其余事件。
          log(`打标失败[plan=${plan.id}]`, error);
        }
      }
    }
  }

  log(
    `事件复核: 候选 ${events.length} 条（闭区间，排 tombstone），命中 ${matchedEvents} 条，打标 ${flaggedPlans} plan`,
  );

  return { scanned: events.length, matchedEvents, flaggedPlans };
}
