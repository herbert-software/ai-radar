/**
 * 纯顺序每日工作流编排（daily-intel-pipeline 10.1 / 10.3，design D7/D8）。
 *
 * runDailyWorkflow 是一个**纯顺序 async 函数**，把 G1–G6 的能力汇成一条链路：
 *   collect（Promise.allSettled 三源，G1）
 *   → 去重塌缩（G2）
 *   → Value Judge 逐条（G3）
 *   → Top N 选择（G4）
 *   → 中文摘要（G5）
 *   → Telegram 推送（G6）
 *
 * BullMQ 只在外层当「定时触发器 + 整 job 重试外壳」（见 ./queue.ts / ./worker.ts），
 * **本函数内不拆阶段队列、不投递消息**——阶段间靠普通 await 顺序衔接。
 *
 * 关键不变量（绝不可违背，design D7/D8）：
 * - 整个日报任务用 acquireDigestLock 包住（finally 释放），保证某 push_date 全局单例。
 * - 降级率**按阶段分别计算、各自独立熔断**：judge 分母 = 送判（未评分）事件数；
 *   摘要分母 = Top N。任一阶段分母 > 0 且其降级率严格 > DEGRADE_ABORT_RATIO → 中止 + 告警，
 *   **不推残缺日报**。分母 = 0 不是错误、不中止：judge 分母 = 0 直接进 Top N（已评分常青
 *   事件仍可推），摘要分母 = 0 正常不推。禁止把「judge 分母 = 0」误判为「今日无候选」中止。
 * - 系统级故障告警以**采集/规范化层**为准：①采集返回条数 = 0 或 ②采集 > 0 但可处理条目数 = 0
 *   → 告警；可处理数含塌缩进既有事件者，故全命中既有事件的正常无新闻日不告警。
 * - 摘要降级用 G5 的 digestEvent（回退 representative_title → canonical_url → 剔除）；绝不推半截。
 *
 * 边界：本模块只编排，调用各组已导出函数，不重写其内部逻辑、不改 schema。
 */
import { inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, rawItems } from '../db/schema.js';
import { env } from '../config/env.js';
import {
  collectAndStore,
  type CollectAllOptions,
} from '../collectors/index.js';
import { collapseUncollapsedRawItems } from '../dedup/collapse.js';
import {
  scoreUnscoredEvents,
  type ScoreEventsOptions,
} from '../agents/value-judge/score-events.js';
import { selectTopN, type SelectedEvent } from '../selection/top-n.js';
import {
  digestEvent,
  type EventForDigest,
} from '../agents/digest/persistence.js';
import type { SummarizeOptions } from '../agents/digest/index.js';
import { dispatchDigest, type MessageSender } from '../push/dispatcher.js';
import { createTelegramSender } from '../push/telegram.js';
import {
  acquireDigestLock,
  type AcquireLockOptions,
} from '../push/lock.js';
import { getPushDate } from '../push/push-date.js';
import {
  classifySystemFailure,
  stageDegradeRate,
  stageShouldAbort,
  type StageDegrade,
} from './circuit-breaker.js';

type DbLike = typeof defaultDb;

/**
 * 告警 sink：把「系统级故障」与「降级率熔断」以可观测方式上报。
 * 默认 console.error（非静默）。生产可注入 Telegram/PagerDuty 等。
 */
export type AlertSink = (message: string, detail?: unknown) => void;

const defaultAlert: AlertSink = (message, detail) =>
  console.error(`[pipeline][ALERT] ${message}`, detail ?? '');

/** 工作流被熔断中止时抛出的信号（编排层据此让 BullMQ job 失败/重试）。 */
export class WorkflowAbortError extends Error {
  /** 触发熔断的阶段。 */
  readonly stage: 'value-judge' | 'digest';
  /** 该阶段降级率。 */
  readonly rate: number;
  constructor(stage: 'value-judge' | 'digest', rate: number) {
    super(
      `日报流水线在「${stage}」阶段降级率 ${(rate * 100).toFixed(1)}% 超阈值，已中止，不推残缺日报。`,
    );
    this.name = 'WorkflowAbortError';
    this.stage = stage;
    this.rate = rate;
  }
}

export interface RunDailyWorkflowOptions {
  /** 参考时刻，决定 push_date 与候选窗口「今天」（默认当前时刻）。 */
  now?: Date;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /** 采集层选项（注入 mock collector / RSS 源等）。 */
  collect?: CollectAllOptions;
  /** Value Judge 阶段选项（注入 mock generateObject 等）。 */
  judge?: ScoreEventsOptions;
  /** 中文摘要阶段选项（注入 mock generateObject 等）。 */
  digest?: SummarizeOptions;
  /** 推送发送器（默认 grammY 真实发送；测试注入 mock）。 */
  sender?: MessageSender;
  /** 单例锁选项（注入 mock Redis / TTL 等）。 */
  lock?: AcquireLockOptions;
  /** 告警 sink（默认 console.error）。 */
  alert?: AlertSink;
  /** 熔断阈值（默认 env.DEGRADE_ABORT_RATIO）。 */
  abortRatio?: number;
}

/** 工作流结束状态（供 worker / 可观测 / 测试断言）。 */
export type WorkflowOutcome =
  | 'pushed' // 正常推送（dispatch outcome=sent）
  | 'skipped-locked' // 未抢到单例锁，本实例放弃
  | 'skipped-no-candidates' // 无待推事件（Top N 空 / 全已 success）
  | 'aborted-degrade'; // 某阶段降级率超阈值中止（不推残缺日报）

export interface RunDailyWorkflowResult {
  outcome: WorkflowOutcome;
  pushDate: string;
  /** 采集返回条数（非新插入行数）。 */
  collectedCount: number;
  /** 可处理条目数（含塌缩进既有事件者）。 */
  processableCount: number;
  /** Value Judge 阶段降级统计。 */
  judge: StageDegrade;
  /** 中文摘要阶段降级统计。 */
  digest: StageDegrade;
  /** 今日 Top N 条数。 */
  topNCount: number;
  /** 是否触发了系统级故障告警。 */
  alerted: boolean;
}

/** 把 Top N 选中事件补齐 canonical_url（供摘要降级回退到 URL）。 */
async function loadCanonicalUrls(
  dbh: DbLike,
  eventIds: readonly string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (eventIds.length === 0) return map;
  // 经 representative_raw_item_id 回指代表 raw_item 的 canonical_url。
  const events = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      repId: aiNewsEvents.representativeRawItemId,
    })
    .from(aiNewsEvents)
    .where(inArray(aiNewsEvents.eventId, eventIds as string[]));

  const repIds = events
    .map((e) => e.repId)
    .filter((x): x is bigint => x !== null);
  const urlByRawId = new Map<string, string | null>();
  if (repIds.length > 0) {
    const raws = await dbh
      .select({ id: rawItems.id, canonicalUrl: rawItems.canonicalUrl })
      .from(rawItems)
      .where(inArray(rawItems.id, repIds));
    for (const r of raws) urlByRawId.set(r.id.toString(), r.canonicalUrl);
  }
  for (const e of events) {
    map.set(
      e.eventId,
      e.repId !== null ? (urlByRawId.get(e.repId.toString()) ?? null) : null,
    );
  }
  return map;
}

/**
 * 跑一次完整每日工作流（纯顺序）。
 *
 * 全程包在 acquireDigestLock（finally 释放）内，保证某 push_date 全局单例。
 * 未抢到锁 → 立即返回 outcome='skipped-locked'，不发任何消息。
 *
 * @param options 注入点（now / db / 各阶段 mock / sender / 锁 / 告警 / 阈值）。
 */
export async function runDailyWorkflow(
  options: RunDailyWorkflowOptions = {},
): Promise<RunDailyWorkflowResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const alert = options.alert ?? defaultAlert;
  const abortRatio = options.abortRatio ?? env.DEGRADE_ABORT_RATIO;
  const pushDate = getPushDate(now);

  // 全局单例锁：某 push_date 只允许一个实例跑（崩溃靠 TTL + finally 释放，design D6）。
  const lock = await acquireDigestLock(pushDate, options.lock);
  if (lock === null) {
    console.error(`[pipeline] 锁: push_date=${pushDate} 未抢到单例锁，本实例放弃`);
    return {
      outcome: 'skipped-locked',
      pushDate,
      collectedCount: 0,
      processableCount: 0,
      judge: { processed: 0, degraded: 0 },
      digest: { processed: 0, degraded: 0 },
      topNCount: 0,
      alerted: false,
    };
  }

  try {
    console.error(`[pipeline] 锁: push_date=${pushDate} 已获取单例锁`);
    // ── 阶段 1：采集（三源 Promise.allSettled 并发）+ 入库（源内幂等）。
    const collected = await collectAndStore({ ...options.collect, dbh });
    const collectedCount = collected.items.length;
    console.error(`[pipeline] 采集: 返回 ${collectedCount} 条`);

    // ── 阶段 2：去重塌缩。处理库内**所有**未塌缩的可处理 raw_items（collapseUncollapsedRawItems，
    //    按 collapsed 标记驱动、幂等）：每条塌缩后置 collapsed=true，source_count 恰好贡献一次，
    //    崩溃补塌缩安全；不再依赖脆弱的 store.insertedIds（Wave2a / Codex C1）。
    const outcomes = await collapseUncollapsedRawItems(dbh);
    console.error(
      `[pipeline] 塌缩: 处理 ${outcomes.length} 条未塌缩 raw_items → 可处理 ${outcomes.filter((o) => !o.unprocessable).length} 条`,
    );

    // 系统级故障告警以采集/规范化层为准（非 judge 分母，design D8）：
    // 判定用 store.processableCount——本轮采集**返回**条目中能构造 dedup_key 的数量
    // （含塌缩进既有事件的源内重复项）。全命中既有事件的正常无新闻日 processableCount>0、不告警；
    // 三源全挂（采集返回 0）或采集 > 0 但全 unprocessable（processableCount===0）才告警。
    const processableCount = collected.store.processableCount;
    const sysFailure = classifySystemFailure({ collectedCount, processableCount });
    let alerted = false;
    if (sysFailure.alert) {
      console.error(`[pipeline] 告警: 系统级故障 kind=${sysFailure.kind}`);
      alert(`系统级故障：${sysFailure.reason}`, {
        kind: sysFailure.kind,
        collectedCount,
        processableCount,
      });
      alerted = true;
    }

    // ── 阶段 3：Value Judge 逐条（只送判未评分事件）。单条降级整批继续（G3 内已容错）。
    const judgeResult = await scoreUnscoredEvents(options.judge, dbh);
    const judgeStage: StageDegrade = {
      processed: judgeResult.judged, // 分母 = 本轮送判（未评分）事件数。
      degraded: judgeResult.degradedCount,
    };
    console.error(
      `[pipeline] Value Judge: 送判 ${judgeStage.processed} 条, 降级 ${judgeStage.degraded} 条`,
    );
    // judge 阶段独立熔断：分母 > 0 且降级率严格 > 阈值 → 中止 + 告警，不推残缺日报。
    if (stageShouldAbort(judgeStage, abortRatio)) {
      const rate = stageDegradeRate(judgeStage)!;
      console.error(
        `[pipeline] 熔断: Value Judge 降级率超阈值，中止流水线`,
      );
      alert(
        `Value Judge 阶段降级率 ${(rate * 100).toFixed(1)}% 超阈值（${(abortRatio * 100).toFixed(0)}%），中止本次流水线。`,
        judgeStage,
      );
      throw new WorkflowAbortError('value-judge', rate);
    }
    // 注意：judge 分母 = 0 时 stageShouldAbort 返回 false——**不中止**，直接进 Top N，
    // 已评分的常青事件仍可入选并推送（禁止误判「今日无候选」）。

    // ── 阶段 4：Top N 选择（程序确定性，不交给 LLM）。
    const topN = await selectTopN({ now }, dbh);
    console.error(`[pipeline] Top N: 入选 ${topN.length} 条`);

    // ── 阶段 5：中文摘要逐条。分母 = Top N。单条降级回退/剔除（G5 内已处理），绝不推半截。
    const canonicalUrls = await loadCanonicalUrls(
      dbh,
      topN.map((e) => e.eventId),
    );
    let digestDegraded = 0; // 本轮**实际送摘要**中失败降级的条数（不含已缓存跳过者）。
    let digestProcessed = 0; // 本轮实际送摘要（summary_zh IS NULL）数，仅供逐条日志/可观测。
    let digestSkipped = 0; // 已有 summary_zh、跳过 digestEvent 的条数（仅可观测）。
    const pushable: SelectedEvent[] = [];
    // 逐条进度：先数出本轮真正要送摘要的条数（未缓存者）作分母 M（仅日志用）。
    const toSummarizeCount = topN.filter((e) => e.summaryZh === null).length;
    let digestStep = 0;
    for (const ev of topN) {
      // 已摘要守卫（design D8/D9）：已有 summary_zh（非 null）→ 跳过 digestEvent，
      // 直接用既有 summary_zh 计入 pushable，避免重复 LLM 调用 / 覆盖旧产物为降级回退。
      if (ev.summaryZh !== null) {
        digestSkipped += 1;
        pushable.push({
          eventId: ev.eventId,
          representativeTitle: ev.representativeTitle,
          summaryZh: ev.summaryZh,
          // 已缓存分支：headline 来自 selectTopN（库内 headline_zh，旧事件为 null 走渲染回退）。
          headlineZh: ev.headlineZh,
          canonicalUrl: canonicalUrls.get(ev.eventId) ?? null,
          publishedAt: ev.publishedAt,
          rankScore: ev.rankScore,
        });
        continue;
      }
      digestProcessed += 1;
      digestStep += 1;
      console.error(
        `[digest] 摘要 ${digestStep}/${toSummarizeCount}（event=${ev.eventId.slice(0, 8)}）`,
      );
      const forDigest: EventForDigest = {
        eventId: ev.eventId,
        representativeTitle: ev.representativeTitle,
        canonicalUrl: canonicalUrls.get(ev.eventId) ?? null,
      };
      const outcome = await digestEvent(forDigest, options.digest, dbh);
      if (outcome.degraded) digestDegraded += 1;
      if (outcome.status === 'dropped') {
        // 无任何可展示文本 → 剔除出当日日报（绝不推半截）。
        continue;
      }
      // summarized（summary_zh 已落库）或 fallback（用 representative_title/URL 回退）
      // 均可推送；dispatcher 优先读 summary_zh，无则用展示标题（见 message 渲染）。
      // C6：fallback 时若 representativeTitle 为空，digestEvent 已返回 canonical_url 兜底
      // fallbackText；用它覆盖展示标题，避免 message 渲染「(无标题)」。
      const summaryZh =
        outcome.status === 'summarized' ? outcome.summaryZh : null;
      const representativeTitle =
        outcome.status === 'fallback'
          ? outcome.fallbackText
          : ev.representativeTitle;
      // 本轮新摘要分支：headline 仅 summarized 变体有；fallback（降级）置 null 走渲染回退链。
      // 必须按 status 收窄（与上方 summaryZh 守卫同形），直取 outcome.headlineZh 会因 fallback 变体无此字段 tsc 失败。
      const headlineZh =
        outcome.status === 'summarized' ? outcome.headlineZh : null;
      pushable.push({
        eventId: ev.eventId,
        representativeTitle,
        summaryZh: summaryZh ?? ev.summaryZh,
        headlineZh,
        canonicalUrl: canonicalUrls.get(ev.eventId) ?? null,
        publishedAt: ev.publishedAt,
        rankScore: ev.rankScore,
      });
    }
    if (digestSkipped > 0) {
      console.error(`[digest] 跳过已摘要 ${digestSkipped} 条`);
    }
    console.error(
      `[pipeline] 摘要: 送摘要 ${digestProcessed} 条（跳过已摘要 ${digestSkipped} 条）, 降级 ${digestDegraded} 条, 熔断分母（Top N）${topN.length}`,
    );
    const digestStage: StageDegrade = {
      // 摘要阶段熔断分母 = 进入摘要的事件数（Top N，含已缓存跳过者），与 spec/design D8 原文一致。
      // 降级分子 = 本轮实际送摘要中失败的条数。如此「7 缓存 + 1 新失败」= 1/8 < 阈值不误熔断。
      processed: topN.length,
      degraded: digestDegraded,
    };
    // 摘要阶段独立熔断：分母 > 0 且降级率严格 > 阈值 → 中止 + 告警。
    // 与 judge 各自独立判定——摘要的少量失败绝不被 judge 大分母稀释（D8）。
    if (stageShouldAbort(digestStage, abortRatio)) {
      const rate = stageDegradeRate(digestStage)!;
      console.error(`[pipeline] 熔断: 中文摘要降级率超阈值，中止流水线`);
      alert(
        `中文摘要阶段降级率 ${(rate * 100).toFixed(1)}% 超阈值（${(abortRatio * 100).toFixed(0)}%），中止本次流水线。`,
        digestStage,
      );
      throw new WorkflowAbortError('digest', rate);
    }

    // ── 阶段 6：Telegram 推送（单消息原子 + push_records 幂等，G6）。
    if (pushable.length === 0) {
      // Top N 为空（摘要分母 = 0，正常不推）或全被剔除 → 无可推，正常结束（不告警、不中止）。
      console.error(`[pipeline] 推送: 待发 0 条 → skipped-no-candidates`);
      return {
        outcome: 'skipped-no-candidates',
        pushDate,
        collectedCount,
        processableCount,
        judge: judgeStage,
        digest: digestStage,
        topNCount: topN.length,
        alerted,
      };
    }

    // 防丢锁双发（Codex C3 消费端）：dispatch 前核对仍真正持有锁。看门狗发现锁被抢/过期
    // 会置租约已失 → isHeld() 返 false。此时**绝不**再发送（否则与抢锁的第二实例双发）。
    // 但绝不能返回成功的 'skipped-no-candidates'（BullMQ 不重试 → 把「租约已失」误标「无候选」，
    // 当日 Top N 漏发到次日）。改为告警 + 抛错使整 job 重试：重试会重新 acquireDigestLock（单例锁
    // 保证不双发）+ 待发集合 = 今日 Top N MINUS 今日已 success（已发不重发、未发补发），故幂等安全。
    if (!lock.isHeld()) {
      console.error(
        `[pipeline] 租约已失（锁被抢占/过期），中止本次以触发重试，避免静默漏发`,
      );
      alert(`日报推送前租约已失（锁被抢占/过期），中止本次并触发重试。`, {
        pushDate,
        topNCount: topN.length,
      });
      throw new Error(
        `digest lease lost: push_date=${pushDate} 推送前租约已失，抛错使 BullMQ 同日重试，避免静默漏发。`,
      );
    }

    const sender = options.sender ?? createTelegramSender();
    const dispatch = await dispatchDigest(pushable, { now, sender }, dbh);
    console.error(
      `[pipeline] 推送: 待发 ${pushable.length} 条 → outcome=${dispatch.outcome}`,
    );

    // C2：dispatch 发送失败（记录已置 failed）必须让整 job 失败 → BullMQ 同 push_date 重试，
    // 重试时这些 failed 条目重新纳入待发集合重发（对齐 telegram-push spec「failed 下次重试」+ D6）。
    // push_records 的 failed 状态已由 dispatcher 落库，锁在 finally 释放，故重试安全。
    // outcome==='skipped'（待发空 / 单条超长）不算失败、不抛。
    if (dispatch.outcome === 'failed') {
      throw new Error(
        `digest dispatch failed: push_date=${pushDate} 发送失败（${dispatch.eventIds.length} 条已置 failed），抛错使 BullMQ 同日重试。`,
      );
    }

    return {
      outcome:
        dispatch.outcome === 'skipped'
          ? 'skipped-no-candidates'
          : 'pushed',
      pushDate,
      collectedCount,
      processableCount,
      judge: judgeStage,
      digest: digestStage,
      topNCount: topN.length,
      alerted,
    };
  } finally {
    await lock.release();
  }
}
