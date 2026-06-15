/**
 * 发布时间回填编排（published-at-inference 1.4 / 1.5 / 1.5b / 1.6，design D2/D4）。
 *
 * 在两条候选链「选候选之前」执行：对 `published_at IS NULL` 且在候选作用域内、且 first_seen_at
 * 仍在时效窗口下界之内的事件，逐条经 Redis per-event 锁抢占 → AI 推断 → CAS 回填。
 *
 * 关键不变量（绝不可违背，design D2/D4 / spec）：
 * - **CAS 回填**：`UPDATE ai_news_events SET published_at = <推断值> WHERE event_id = ?
 *   AND published_at IS NULL AND <推断值> <= now()`（DB 端时钟）。`published_at IS NULL` 保证
 *   绝不覆盖已非 NULL（来自采集 / 塌缩 COALESCE / 另一链路先回填）；`<= now()` 是范围上界兜底
 *   （拦任何来源未来值，与 schema refine 构成双层防御）。后写者 WHERE 不命中即空操作。
 * - **Redis per-event 锁** `published-at-infer:{event_id}`：与告警分发锁 `alert:{event_id}` **区分开**
 *   （否则回填与告警分发争用同锁）。复用 acquireAlertLock 的获取/释放语义（SET NX PX <ttl> 原子获取、
 *   finally 经核对 token 的 release()）；**禁止复用 judge_claimed_at 列**（语义/条件冲突，design D2）。
 * - **Redis 异常降级**：acquireAlertLock 在 SET 出错时**会抛**——本模块 try/catch 把抛错降级为
 *   「跳过本事件、记日志、不抛断」（这是新模块在 acquireAlertLock 之外额外加的一层，非其本体行为）。
 * - **降级总原则**：LLM 失败/超时/越界/未抢锁/Redis 异常/CAS 的 DB 写异常 —— 一律 catch、
 *   记 error 日志、按该事件「未回填」降级，绝不抛断、绝不回填 now()/fetchedAt/任意默认值
 *   （遵 score-events.ts「写库异常计降级、不抛」口径）。
 * - **独立单次上限 + 超窗剪枝**：`WHERE published_at IS NULL AND <候选条件> AND
 *   first_seen_at >= <时效窗口下界> ORDER BY first_seen_at DESC LIMIT <PUBLISHED_AT_INFERENCE_MAX_PER_RUN>`
 *   ——超窗老 NULL 事件不纳入（推断出来也必出窗），超出上限者下轮补填。
 * - **回填阶段不计入降级率熔断**（编排组职责，本模块只返回统计、不在此熔断）。
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiNewsEvents, rawItems } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { startOfDayInTimeZone } from '../../push/push-date.js';
import {
  acquireAlertLock,
  type AcquireAlertLockOptions,
} from '../../pipeline/alert-lock.js';
import {
  inferPublishedAt,
  DEFAULT_MAX_ATTEMPTS,
  type InferPublishedAtOptions,
} from './index.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 推断锁 TTL 的 CAS 写裕量（毫秒）：覆盖单次条件 UPDATE 的提交延迟上界，叠加在「最坏推断时长」上。 */
const INFER_CAS_WRITE_SLACK_MS = 30_000;

/** 回填 Redis 锁键：`published-at-infer:{event_id}`（与告警锁 `alert:{event_id}` 区分开）。 */
export function publishedAtInferLockKey(eventId: string): string {
  return `published-at-infer:${eventId}`;
}

/**
 * 回填作用域（候选条件）——由两条链分别传入：
 * - 日报链：`{ kind: 'daily' }` → `should_push = true`。
 * - 告警链：`{ kind: 'alert', threshold }` → `importance_score IS NOT NULL AND >= threshold`。
 */
export type BackfillScope =
  | { kind: 'daily' }
  | { kind: 'alert'; threshold: number };

export interface BackfillPublishedAtOptions {
  /** 回填作用域（日报 should_push / 告警达阈值），必填。 */
  scope: BackfillScope;
  /** 时效窗口天数（与候选窗口同源）；下界 = startOfDayInTimeZone(now, windowDays-1)。 */
  windowDays: number;
  /** 参考时刻（决定窗口下界 + 推断范围上界），默认 new Date()。 */
  now?: Date;
  /** 单轮上限（默认 env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN）。 */
  maxPerRun?: number;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /** 透传给 inferPublishedAt 的选项（注入 mock generateObjectFn、maxAttempts 等）。 */
  infer?: Omit<InferPublishedAtOptions, 'now'>;
  /** Redis 锁选项（注入 mock Redis / TTL；锁键由本模块覆盖为 published-at-infer:{event_id}）。 */
  lock?: AcquireAlertLockOptions;
  /** 错误/日志 sink，默认 console.error；便于测试断言降级被记录（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
}

/** 回填统计（供可观测/测试断言；回填阶段绝不计入降级率熔断分母）。 */
export interface BackfillPublishedAtResult {
  /** 本轮选入回填作用域、实际尝试（抢锁后）的事件数。 */
  attempted: number;
  /** CAS 成功落值的事件数。 */
  backfilled: number;
  /** 未抢到 Redis 锁（或 Redis 异常）而跳过的事件数。 */
  skippedLocked: number;
  /** AI 判不出（推断返回 null）而保持 NULL 的事件数。 */
  undetermined: number;
  /** CAS 的 DB 写异常等失败、按「未回填」降级的事件数。 */
  failed: number;
}

/** 一条待回填事件的最小视图（含代表 raw_item 线索，经 representative_raw_item_id 回指）。 */
interface BackfillCandidate {
  eventId: string;
  title: string;
  canonicalUrl: string | null;
  content: string | null;
  source: string | null;
}

/** 把作用域映射为候选 SQL 谓词（确定性条件，全程程序层，无 LLM）。 */
function scopePredicate(scope: BackfillScope): SQL {
  if (scope.kind === 'daily') {
    // 日报链：Value Judge 写过 should_push=true 的事件才进回填域（评分后才有 should_push）。
    return eq(aiNewsEvents.shouldPush, true);
  }
  // 告警链：评分后达阈值（importance_score 非 NULL 且 >= threshold）。
  return and(
    sql`${aiNewsEvents.importanceScore} IS NOT NULL`,
    gte(aiNewsEvents.importanceScore, String(scope.threshold)),
  ) as SQL;
}

/**
 * 对一个候选作用域内的 NULL published_at 事件做一轮回填。
 *
 * 流程（design D2/D4）：
 * 1. 查 `published_at IS NULL AND <候选条件> AND first_seen_at >= <窗口下界>`
 *    `ORDER BY first_seen_at DESC LIMIT <上限>`（超窗剪枝 + 成本闸 + 优先最近首见）。
 * 2. 逐条：抢 Redis 锁（`published-at-infer:{event_id}`）→ 推断 → CAS 回填 → finally 释放锁。
 * 3. 所有失败（未抢锁 / Redis 异常 / LLM 判不出 / 越界 / CAS DB 写异常）按该事件降级、不抛断。
 *
 * 与 1.4 CAS + 1.5 Redis 锁配合，使日报链 / 告警链并发回填同一事件时仅一次调 LLM + CAS 仅一次落值。
 */
export async function backfillPublishedAt(
  options: BackfillPublishedAtOptions,
): Promise<BackfillPublishedAtResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const maxPerRun = options.maxPerRun ?? env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN;
  const logError =
    options.logError ??
    ((message, detail) =>
      console.error(`[published-at-inference] ${message}`, detail));

  // 推断锁 TTL 必须覆盖「最坏单次推断 + CAS 写」时长（spec / design D2）：inferPublishedAt 最坏跑
  // maxAttempts 次、每次 AbortSignal.timeout(LLM_TIMEOUT_MS)，故最坏推断 = maxAttempts × LLM_TIMEOUT_MS，
  // 再加 CAS 写裕量。**不可**沿用告警锁默认 ALERT_LOCK_TTL_MS（按「单事件渲染+单通道送达」定，远短于推断），
  // 否则慢推断中途锁过期 → 并发链路重获锁重复调 LLM（CAS 仍保不双落值，但浪费 LLM 配额，违反锁职责）。
  const inferMaxAttempts = options.infer?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const inferLockTtlMs =
    env.LLM_TIMEOUT_MS * inferMaxAttempts + INFER_CAS_WRITE_SLACK_MS;

  // 时效窗口下界：与候选窗口同源（startOfDayInTimeZone，Asia/Shanghai），防口径漂移。
  // windowDays>0：下界 = 「今天往前 windowDays-1 个自然日」00:00，剪掉超窗老 NULL 事件（推断出来也必出窗）。
  // windowDays<=0（告警「不限窗口」旁路，ALERT_FIRST_SEEN_WINDOW_DAYS=0）：候选侧无时效下界，回填侧亦
  // 不设 first_seen 下界剪枝（保持与候选域一致，否则旁路下昨天及更早 first_seen 的 NULL 事件会漏回填）；
  // 成本仍由下方 LIMIT maxPerRun 封顶，不依赖 first_seen 剪枝控量。日报链 FIRST_SEEN_WINDOW_DAYS 恒 >0。
  const lowerBound =
    options.windowDays > 0
      ? startOfDayInTimeZone(now, options.windowDays - 1)
      : null;

  // 候选集（超窗剪枝 + 成本闸）：
  //   published_at IS NULL AND <候选条件> AND first_seen_at >= <窗口下界>
  //   ORDER BY first_seen_at DESC LIMIT <上限>
  // first_seen_at >= 下界：超窗老 NULL 事件不纳入（推断出来也必被时效闸排除，避免占满配额饿死近期）。
  // 读代表 raw_item 线索：innerJoin rawItems on representative_raw_item_id 取 title/canonical_url/
  // content/source（无代表 raw_item 的事件——理论上不存在，innerJoin 自然排除，不进推断）。
  const candidates: BackfillCandidate[] = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      title: rawItems.title,
      canonicalUrl: rawItems.canonicalUrl,
      content: rawItems.content,
      source: rawItems.source,
    })
    .from(aiNewsEvents)
    .innerJoin(rawItems, eq(aiNewsEvents.representativeRawItemId, rawItems.id))
    .where(
      and(
        isNull(aiNewsEvents.publishedAt),
        scopePredicate(options.scope),
        // P3 tombstone 排除（合并核心闭环）：候选 SELECT 加 `merged_into IS NULL`——不浪费推断预算在
        // 被吞 tombstone 上、不在 tombstone 落 published_at（spec「tombstone 对所有下游消费者不可见」）。
        isNull(aiNewsEvents.mergedInto),
        lowerBound !== null
          ? gte(aiNewsEvents.firstSeenAt, lowerBound)
          : undefined,
      ),
    )
    .orderBy(desc(aiNewsEvents.firstSeenAt))
    .limit(maxPerRun);

  let attempted = 0;
  let backfilled = 0;
  let skippedLocked = 0;
  let undetermined = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // ── 抢 Redis per-event 锁（防日报链/告警链对同一事件重复调 LLM）。
    // acquireAlertLock 在 Redis SET 出错时**会抛**——try/catch 把抛错降级为「跳过本事件」、不抛断。
    let lock: Awaited<ReturnType<typeof acquireAlertLock>>;
    try {
      lock = await acquireAlertLock(candidate.eventId, {
        ...options.lock,
        key: publishedAtInferLockKey(candidate.eventId),
        // TTL 覆盖最坏推断 + CAS 写（见上 inferLockTtlMs）；测试可经 options.lock.ttlMs 覆盖。
        ttlMs: options.lock?.ttlMs ?? inferLockTtlMs,
      });
    } catch (error) {
      // Redis 自身异常（连接挂等）：降级为跳过本事件回填，记日志，不抛断流水线。
      skippedLocked += 1;
      logError(
        `事件 ${candidate.eventId} 获取回填 Redis 锁异常（跳过本轮回填，不抛断）`,
        error,
      );
      continue;
    }

    if (lock === null) {
      // 未抢到锁：另一链路正回填该事件，跳过（CAS 兜底正确性，不重复调 LLM）。
      skippedLocked += 1;
      continue;
    }

    attempted += 1;
    try {
      // ── AI 推断（失败/超时/越界 → 返回 null，inferPublishedAt 内部已降级不抛）。
      const inferred = await inferPublishedAt(
        {
          title: candidate.title,
          canonicalUrl: candidate.canonicalUrl,
          content: candidate.content,
          source: candidate.source,
        },
        { ...options.infer, now },
      );

      if (inferred === null) {
        // 判不出：保持 NULL，不回填臆造时间（候选过滤层「NULL 即排除」兜底）。
        undetermined += 1;
        continue;
      }

      // ── CAS 回填：仅当仍 NULL 且推断值 <= now() 才落值（不覆盖已非 NULL；范围上界兜底）。
      // DB 端时钟 now()（防进程钟漂）。后写者 WHERE 不命中 → 0 行更新 → 自动空操作（不覆盖）。
      try {
        const updated = await dbh
          .update(aiNewsEvents)
          .set({ publishedAt: new Date(inferred) })
          .where(
            and(
              eq(aiNewsEvents.eventId, candidate.eventId),
              isNull(aiNewsEvents.publishedAt),
              // P3 tombstone 排除（合并核心闭环）：回填 CAS 自身 WHERE 加 `merged_into IS NULL`——同
              // value-judge 的 TOCTOU 理由（告警链 backfillPublishedAt 不持日报锁，SELECT→CAS 分离，
              // 间隙日报合并可把本事件置 tombstone）。谓词落 CAS 才使「tombstone 绝不被回填复活」成立。
              isNull(aiNewsEvents.mergedInto),
              sql`${new Date(inferred)} <= now()`,
            ),
          )
          .returning({ eventId: aiNewsEvents.eventId });

        if (updated.length > 0) {
          backfilled += 1;
        } else {
          // WHERE 未命中（已被另一链路先回填、或推断值 > DB now()）：非失败，按「未落值」记。
          undetermined += 1;
        }
      } catch (error) {
        // 回填 CAS 的 DB 写异常（连接挂/死锁等）：catch、按「未回填」降级、记日志，绝不冒泡中止流水线
        // （遵 score-events.ts「写库异常计降级不抛」口径）。
        failed += 1;
        logError(
          `事件 ${candidate.eventId} 回填 CAS 写库异常（按未回填降级，不抛断）`,
          error,
        );
      }
    } finally {
      // finally 经核对 token 的 release() 删锁（防误删他人锁）；释放尽力而为，失败由 TTL 兜底。
      await lock.release().catch((releaseErr: unknown) =>
        logError(
          `事件 ${candidate.eventId} 释放回填 Redis 锁失败（将由 TTL 兜底）`,
          releaseErr,
        ),
      );
    }
  }

  return { attempted, backfilled, skippedLocked, undetermined, failed };
}
