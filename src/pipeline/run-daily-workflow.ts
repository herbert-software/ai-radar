/**
 * 纯顺序每日工作流编排（daily-intel-pipeline 10.1 / 10.3，design D7/D8）。
 *
 * runDailyWorkflow 是一个**纯顺序 async 函数**，把 G1–G6 的能力汇成一条链路：
 *   collect（Promise.allSettled 三源，G1）
 *   → 去重塌缩（G2）
 *   → Value Judge 逐条（G3）
 *   → Top N 选择（G4）
 *   → 中文摘要（G5）
 *   → 多通道推送（向所有已配置通道并发分发：Telegram 必配 + 飞书可选，G6）
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
import { and, inArray, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, rawItems } from '../db/schema.js';
import { env } from '../config/env.js';
import {
  collectAndStore,
  type CollectAllOptions,
} from '../collectors/index.js';
import { createLookbackArxivCursorStore } from '../collectors/arxiv-cursor.js';
import { collapseUncollapsedRawItems } from '../dedup/collapse.js';
import {
  semanticMergeEvents,
  type SemanticMergeOptions,
  type SemanticMergeResult,
} from '../dedup/semantic-merge.js';
import {
  runKbIngestion,
  type RunKbIngestionOptions,
  type KbIngestionResult,
} from '../kb/index.js';
import {
  scoreUnscoredEvents,
  type ScoreEventsOptions,
} from '../agents/value-judge/score-events.js';
import { selectTopN, type SelectedEvent } from '../selection/top-n.js';
import {
  suppressEventsInProducts,
  PLATFORM_HOSTS,
  type EventWithKeys,
} from '../selection/cross-segment-dedup.js';
// extractProductMergeKeys 来自 collectors/product-keys（零 db/env 纯 leaf）。run-daily 已 import
// collectAndStore（collectors/index）→ pipeline→collectors 依赖边已存在，import 此纯 leaf 是同向良性边。
import { extractProductMergeKeys } from '../collectors/product-keys.js';
import { backfillPublishedAt } from '../agents/published-at-inference/backfill.js';
import type { InferPublishedAtOptions } from '../agents/published-at-inference/index.js';
import type { AcquireAlertLockOptions } from './alert-lock.js';
import {
  digestEvent,
  type EventForDigest,
} from '../agents/digest/persistence.js';
import type { SummarizeOptions } from '../agents/digest/index.js';
import {
  dispatchDailyDigest,
  type DailyDispatchResult,
  type MessageSender,
} from '../push/dispatcher.js';
import {
  collapseProductsOnce,
  digestPendingProducts,
  selectProductsForChannelSafe,
} from './product-digest.js';
import { createTelegramSender } from '../push/telegram.js';
import { createFeishuSender } from '../push/feishu.js';
import { CHANNEL, type Channel } from '../push/targets.js';
import { isFeishuEnabled } from '../config/env.js';
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
import type { BackfillPublishedAtResult } from '../agents/published-at-inference/backfill.js';

type DbLike = typeof defaultDb;

/**
 * 日报单例锁默认 TTL（毫秒）：30 分钟。覆盖含**多通道并发分发**的最坏 runDailyWorkflow 时长
 * （采集多源 + 数百条逐条 LLM 判断 + 逐条摘要 + Telegram/飞书并发分发，feishu-push 5.4）。
 * 相比 lock.ts 的 15min 默认上调一倍，给 P2 多通道留足余量；配合看门狗按 TTL/3 续租，
 * 长任务不会中途失锁致第二实例双发。崩溃时该 TTL 是「同日重新获取锁」的恢复上界。
 */
const DEFAULT_DIGEST_LOCK_TTL_MS = 30 * 60 * 1000;

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
  /**
   * Telegram 推送发送器（默认 grammY 真实发送；测试注入 mock）。
   * 向后兼容字段：等价于 `senders.telegram`。同时传 `senders.telegram` 时以 `senders` 为准。
   */
  sender?: MessageSender;
  /**
   * 各通道发送器显式注入（多通道分发）。键为 channel；提供则覆盖该通道默认 sender。
   * 未提供某已配置通道的 sender 时按 env 构造真实 sender（telegram→grammY、feishu→webhook）。
   * 测试可注入飞书 mock sender 在不配真实 FEISHU env 时验证多通道分发 / 单通道失败隔离。
   */
  senders?: Partial<Record<Channel, MessageSender>>;
  /**
   * 覆盖「已配置通道集」（测试用：无需真实 FEISHU env 即可让 feishu 参与分发）。
   * 默认按 env 计算：恒含 telegram；isFeishuEnabled() 为真时加 feishu。
   */
  channels?: readonly Channel[];
  /** 单例锁选项（注入 mock Redis / TTL 等）。 */
  lock?: AcquireLockOptions;
  /** 告警 sink（默认 console.error）。 */
  alert?: AlertSink;
  /** 熔断阈值（默认 env.DEGRADE_ABORT_RATIO）。 */
  abortRatio?: number;
  /**
   * 发布时间回填阶段的推断选项（透传给 backfillPublishedAt 的 `infer`）。
   * 注入 mock generateObjectFn / maxAttempts 等，使测试控制推断结果、不依赖真实 LLM。
   */
  publishedAtInfer?: Omit<InferPublishedAtOptions, 'now'>;
  /**
   * 发布时间回填阶段的 Redis 锁选项（透传给 backfillPublishedAt 的 `lock`）。
   * 注入 mock Redis / TTL；不传则用真实 Redis（集成测有真实 Redis 可用）。
   */
  publishedAtLock?: AcquireAlertLockOptions;
  /**
   * 语义去重阶段选项（透传给 semanticMergeEvents 的 embedding / search / judge 桩；P3 语义层，6.1）。
   * 注入 mock embedManyFn / generateObjectFn / 阈值等，使测试不触真实 embedding/LLM。
   * `thisRoundEventIds` 由本编排在 collapse 之后注入（调用方无需自带）。
   */
  semantic?: Omit<SemanticMergeOptions, 'now' | 'thisRoundEventIds'>;
  /**
   * 知识库入库阶段选项（透传给 runKbIngestion 的 agent / embed / store 桩；P3 KB 层，6.2）。
   * 注入 mock generateObjectFn / embedManyFn 等，使测试不触真实 LLM/embedding。
   * `now` 由本编排注入（候选 push_date 与 push 阶段同源）。
   */
  kb?: Omit<RunKbIngestionOptions, 'now'>;
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
  /** 采集返回条数（registry 全部源汇总，非新插入行数）。 */
  collectedCount: number;
  /**
   * **新闻类**可处理条目数（含塌缩进既有新闻事件者；排除 product/paper）。
   * 系统级「新闻真空」告警的分母（feishu-push 5.7）；与 store.processableCount 的全量口径不同。
   */
  newsProcessableCount: number;
  /** Value Judge 阶段降级统计。 */
  judge: StageDegrade;
  /** 中文摘要阶段降级统计。 */
  digest: StageDegrade;
  /** 今日 Top N 条数。 */
  topNCount: number;
  /** 是否触发了系统级故障告警。 */
  alerted: boolean;
  /**
   * 发布时间回填阶段统计（**仅可观测**，绝不影响 outcome / 熔断）。
   * 回填的「判不出/失败」绝不计入 DEGRADE_ABORT_RATIO 分母（只含 judge + digest 两阶段）。
   * 未执行回填（如未抢到锁提前返回）时为 undefined。
   */
  publishedAtBackfill?: BackfillPublishedAtResult;
  /**
   * 语义去重阶段统计（**仅可观测**，绝不影响 outcome / 熔断；P3 语义层，6.1）。
   * 语义降级（embedding/检索/LLM judge/合并冲突）一律「不合并」、不抛断、不计入 judge/digest
   * 熔断分母（语义层独立）。`SEMANTIC_DEDUP_ENABLED=off` 或阶段未执行（如未抢到锁提前返回）时为 undefined。
   */
  semantic?: SemanticMergeResult;
  /**
   * 知识库入库阶段统计（**仅可观测**，绝不影响 outcome / 熔断；P3 KB 层，6.2）。
   * KB 阶段在 push 成功之后运行、永不向上抛、降级不计入 judge/digest 熔断分母。
   * 未执行（如早退 / 未抢到锁）时为 undefined。
   */
  kb?: KbIngestionResult;
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

  // 全局单例锁：某 push_date 只允许一个实例跑（崩溃靠 TTL + finally 释放，design D5/D6）。
  // **TTL 须覆盖含多通道并发分发的最坏时长**（feishu-push 5.4 / telegram-push「日报任务全局单例」）：
  // 采集多源 + 逐条 LLM 判断 + 逐条摘要 + 向 Telegram 与飞书**并发**分发。并发分发使两通道增量
  // 有界（非串行叠加），相比 P1 单通道只增有限量；配合看门狗按 TTL/3 续租，长任务不会中途失锁。
  // 未注入 lock 选项（生产）时显式给一个覆盖该最坏时长的 TTL（取代 lock.ts 的 15min 默认）；
  // 注入 lock 选项（测试）时按注入值，保持用例对 TTL 的精确控制。
  const lockOptions: AcquireLockOptions =
    options.lock ?? { ttlMs: DEFAULT_DIGEST_LOCK_TTL_MS };
  const lock = await acquireDigestLock(pushDate, lockOptions);
  if (lock === null) {
    console.error(`[pipeline] 锁: push_date=${pushDate} 未抢到单例锁，本实例放弃`);
    return {
      outcome: 'skipped-locked',
      pushDate,
      collectedCount: 0,
      newsProcessableCount: 0,
      judge: { processed: 0, degraded: 0 },
      digest: { processed: 0, degraded: 0 },
      topNCount: 0,
      alerted: false,
    };
  }

  try {
    console.error(`[pipeline] 锁: push_date=${pushDate} 已获取单例锁`);
    // ── 阶段 1：采集（多源 Promise.allSettled 并发）+ 入库（源内幂等）。
    //    arXiv 增量游标接线（at-least-once，source-collectors / design D3）：arXiv **只在日报链采**
    //    （非实时，不在告警链）。注入固定回溯窗口游标（now − 7d 作 OAI-PMH `from`）使日报每轮按
    //    回溯窗口增量采集而非每轮全量或固定一点；无漏窗 + crash-safe 由「固定窗口重叠 + store 层
    //    UNIQUE(source, source_item_id) 幂等」共同保障（见 arxiv-cursor.ts）。仅当调用方未自带 arxiv
    //    采集选项（测试可注入桩/自带游标）时注入默认游标，不覆盖测试注入。
    const collectOptions = withDefaultArxivCursor(options.collect);
    const collected = await collectAndStore({ ...collectOptions, dbh });
    const collectedCount = collected.items.length;
    console.error(`[pipeline] 采集: 返回 ${collectedCount} 条`);

    // ── 阶段 2：去重塌缩。处理库内**所有**未塌缩的可处理 raw_items（collapseUncollapsedRawItems，
    //    按 collapsed 标记驱动、幂等）：每条塌缩后置 collapsed=true，source_count 恰好贡献一次，
    //    崩溃补塌缩安全；不再依赖脆弱的 store.insertedIds（Wave2a / Codex C1）。
    const outcomes = await collapseUncollapsedRawItems(dbh);
    // **新闻类可处理条目数**（feishu-push 5.7 / daily-intel-pipeline MODIFIED）：
    // collapseUncollapsedRawItems 的查询层已排除 raw_type product/paper，故其 outcomes 只含
    // **新闻类** raw_items；其中 unprocessable=false 即「能塌缩进新闻事件」（含塌缩进既有新闻事件）。
    // 这与 store.processableCount（统计全部条目含 product/paper 的通用「可入库」口径）语义不同——
    // 系统级「新闻真空」告警必须用**新闻类**分母，否则「仅 arXiv 返回 paper、新闻源全空」时
    // paper 会被 store 口径计入而掩盖新闻真空使告警失灵。
    const newsProcessableCount = outcomes.filter((o) => !o.unprocessable).length;
    console.error(
      `[pipeline] 塌缩: 处理 ${outcomes.length} 条未塌缩新闻类 raw_items → 新闻类可处理 ${newsProcessableCount} 条`,
    );

    // 系统级故障告警以采集/规范化层为准（非 judge 分母，design D8），**仅日报链套用**：
    // ①采集返回 0（registry 全部源失败）或 ②采集 > 0 但新闻类可处理数 = 0（全部新闻条目 unprocessable，
    // 或仅有 product/paper 非新闻条目）→ 告警。全命中既有新闻事件的正常无新闻日 newsProcessableCount>0、不告警。
    const sysFailure = classifySystemFailure({
      collectedCount,
      newsProcessableCount,
    });
    let alerted = false;
    if (sysFailure.alert) {
      console.error(`[pipeline] 告警: 系统级故障 kind=${sysFailure.kind}`);
      alert(`系统级故障：${sysFailure.reason}`, {
        kind: sysFailure.kind,
        collectedCount,
        newsProcessableCount,
      });
      alerted = true;
    }

    // ── 阶段 2.5：语义去重（P3 第三/四层 + 确定性合并，spec「语义去重仅作用于日报链新闻事件」/ design D3）。
    //    **位置约束**：collapse 之后、value-judge 之前——合并必在 push **之前**完成（跨天幂等前提：
    //    存活者通常为前日已 push 的较早事件，push 候选「从未以该 channel success」据此跳过、同事件次日不重推），
    //    且被吞 tombstone 须在 value-judge 候选 SELECT 前置就位才不会被复活评分（tombstone 排除已由组 4.7 收口）。
    //    **仅日报链调用**：实时告警链（alert-scan.ts）恒走硬去重快路径、不调本阶段（6.3）。
    //    **SEMANTIC_DEDUP_ENABLED 开关**：为 'off' 时整阶段跳过，退回纯硬去重态、其余阶段照常（spec「开关关闭退回硬去重」）。
    //    **降级安全 + 不进熔断分母**：semanticMergeEvents 内部逐事件 catch（embedding/检索/LLM judge/合并冲突
    //    一律「不合并」、保留独立、不抛断），故本编排对语义阶段不构造 StageDegrade、不传 stageShouldAbort、
    //    绝不进 DEGRADE_ABORT_RATIO 分母（熔断分母仍只含 judge + digest 两阶段，语义层独立）；统计仅记日志（可观测）。
    let semanticResult: SemanticMergeResult | undefined;
    if (env.SEMANTIC_DEDUP_ENABLED === 'on') {
      // 嵌入顺序须「先嵌本轮新事件」（保今日新事件本轮即可作查询对象，spec「嵌入顺序」）：把本轮 collapse
      // 可处理 outcomes 的 dedup_key 解析为「仍 embedding IS NULL 且非 tombstone」的事件 id 集传入。
      // collapse outcomes 不直接给 event_id（仅 dedup_key），故经 dedup_key 反查；空集时 bootstrap 退化为
      // 纯 first_seen_at 升序（仍正确，只是不保证本轮新事件优先嵌入）。
      const thisRoundDedupKeys = [
        ...new Set(
          outcomes
            .filter((o) => !o.unprocessable && o.dedupKey !== null)
            .map((o) => o.dedupKey as string),
        ),
      ];
      let thisRoundEventIds: string[] = [];
      if (thisRoundDedupKeys.length > 0) {
        const rows = await dbh
          .select({ eventId: aiNewsEvents.eventId })
          .from(aiNewsEvents)
          .where(
            and(
              inArray(aiNewsEvents.dedupKey, thisRoundDedupKeys),
              isNull(aiNewsEvents.embedding),
              isNull(aiNewsEvents.mergedInto),
            ),
          );
        thisRoundEventIds = rows.map((r) => r.eventId);
      }
      semanticResult = await semanticMergeEvents(
        {
          now,
          ...options.semantic,
          ...(thisRoundEventIds.length > 0 ? { thisRoundEventIds } : {}),
        },
        dbh,
      );
      console.error(
        `[pipeline] 语义去重: 处理 ${semanticResult.processed} 条, ` +
          `高相似合并 ${semanticResult.highAutoMerged} 条, LLM 确认合并 ${semanticResult.llmConfirmedMerged} 条, ` +
          `LLM 不合并 ${semanticResult.llmNotMerged} 条, 异常跳过 ${semanticResult.skippedError} 条, ` +
          `embedding(候选 ${semanticResult.embedding.candidates}/嵌入 ${semanticResult.embedding.embedded}/失败 ${semanticResult.embedding.failed})（不计入熔断）`,
      );
    } else {
      console.error('[pipeline] 语义去重: SEMANTIC_DEDUP_ENABLED=off，跳过语义层（退回纯硬去重）');
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

    // ── 阶段 3.5：发布时间回填（published-at-inference，daily spec / design D2/D4）。
    // **必在 Value Judge 之后、Top N 之前**：对「should_push=true 且 published_at IS NULL」的收窄
    // 候选域，逐条经 Redis per-event 锁 → AI 推断 → CAS 回填（受 PUBLISHED_AT_INFERENCE_MAX_PER_RUN
    // 上限 + first_seen_at 超窗剪枝约束）。能补的补、补不出（AI 判不出）的保持 NULL 由 Top N 时效闸排除。
    // **绝不计入降级率熔断**（daily spec「每日定时单队列顺序编排」/ design D2）：回填的「判不出/失败」
    // 是预期高比例的安全失败方向，绝不构造 StageDegrade、绝不传 stageShouldAbort/stageDegradeRate、
    // 绝不进 DEGRADE_ABORT_RATIO 分母——熔断分母仍只含 judgeStage / digestStage 两阶段。回填统计仅
    // 记日志（可观测），失败降级不抛断、不阻塞后续阶段（backfillPublishedAt 内部已逐事件 catch 降级）。
    const backfillStats = await backfillPublishedAt({
      scope: { kind: 'daily' },
      windowDays: env.FIRST_SEEN_WINDOW_DAYS,
      now,
      dbh,
      // exactOptionalPropertyTypes：仅在显式注入时透传，避免传 undefined 给「可选非 undefined」字段。
      ...(options.publishedAtInfer ? { infer: options.publishedAtInfer } : {}),
      ...(options.publishedAtLock ? { lock: options.publishedAtLock } : {}),
      logError: (message, detail) =>
        console.error(`[pipeline][published-at-inference] ${message}`, detail),
    });
    console.error(
      `[pipeline] 发布时间回填: 尝试 ${backfillStats.attempted} 条, 回填 ${backfillStats.backfilled} 条, ` +
        `判不出 ${backfillStats.undetermined} 条, 失败 ${backfillStats.failed} 条（不计入熔断）`,
    );

    // ── 阶段 4：Top N 选择（程序确定性，不交给 LLM）。统一日报模型 Model B：选一份 channel-blind
    // Top N，候选窗口排除「已投递给所有已配置通道」者（还差任一通道就留在名单、由各通道 per-channel
    // 跨天补发）。故先解析「已配置通道集」传入 selectTopN（同一份 channelSenders 在阶段 6 复用分发）。
    const channelSenders = resolveChannelSenders(options);
    const topN = await selectTopN(
      { now, channels: channelSenders.map((c) => c.channel) },
      dbh,
    );
    console.error(
      `[pipeline] Top N: 入选 ${topN.length} 条（已配置通道：${channelSenders
        .map((c) => c.channel)
        .join(', ')}）`,
    );

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

    // ── 阶段 5.5：产品段（design D1/D5/D6）——新闻链之后、早退判断之前，在日报锁内执行。
    //    **位置约束**：必在 judge(:326)/digest 熔断 throw **之后**——熔断日整条日报（含新品段）当日
    //    不推、次日 cron 补（design 风险节），故产品段拿不到熔断累加变量、天然不进熔断分母。
    //    P1（塌缩）/P2（候选）均**永不向上抛**（异常转空段+告警），「产品失败不拖垮新闻」由这两个
    //    薄包装保证。productsByChannel **算一次、贯穿早退判断与 dispatch**（dispatch 不重算）。
    //
    //    步骤 P1：产品塌缩一次（channel-blind）。**必在 channel 展开之前只跑一次**——产品塌缩单实例
    //    承载（顺序处理避免同批竞态），若随 per-channel 并发跑 N 次会违反单实例假设。
    await collapseProductsOnce(dbh);
    //    步骤 P1.5：产品中文化一次（channel-blind，design D3）。**必在塌缩之后、per-channel 候选之前**：
    //    中文化候选 = 各 channel 推送候选精确并集（复用 selectProductCandidates 取 product_id 并集）；
    //    UPDATE 中文列后，下方 selectProductsForChannelSafe 再调 selectProductCandidates 读到中文列。
    //    **永不向上抛**（对称 collapseProductsOnce）：中文化失败不进熔断分母、不中止流水线、要闻段不受影响；
    //    整步失败规模异常由 digestPendingProducts 内部 alert 单独告警（系统故障可观测）。
    await digestPendingProducts(
      dbh,
      channelSenders.map((c) => c.channel),
      alert,
    );
    //    步骤 P2：per-channel 产品候选。候选是纯 SELECT 无写竞态、塌缩已在上面单次完成，故可并发。
    //    每 channel 候选包 try/catch（selectProductsForChannelSafe 内），失败 → 该 channel 空新品段。
    const productEntries = await Promise.all(
      channelSenders.map(
        async ({ channel }): Promise<[Channel, SelectedEvent[]]> => [
          channel,
          await selectProductsForChannelSafe(channel, dbh),
        ],
      ),
    );
    const productsByChannel = new Map<Channel, SelectedEvent[]>(productEntries);
    console.error(
      `[pipeline] 产品段: ${channelSenders
        .map((c) => `${c.channel}=${(productsByChannel.get(c.channel) ?? []).length}`)
        .join(', ')}`,
    );

    // ── 阶段 5.6：要闻段↔新品段跨段去重抑制（确定性兜底，design D3/D4）。
    //    位置：productsByChannel 之后、早退判断之前。同一项目既在要闻段又在新品段时，从要闻段
    //    剔除该事件、保留新品段（Show HN/Launch HN 等本质是产品，新品段是其正确归属、带官网链接与
    //    中文简介）。对齐键 = 产品归一三键组（canonical_domain/github_repo/product_hunt_slug），复用
    //    extractProductMergeKeys 两侧一致提取——纯程序确定性键，绝不经 LLM。
    //
    //    (a) 事件侧键**现提取**：对每个 pushable 事件用 canonicalUrls.get(eventId) 调
    //        extractProductMergeKeys({url}) 提三键（事件侧只传 url，product_hunt_slug 分支不触发，
    //        github.com 域被该函数置 null、改由 github_repo 精确对齐）。事件侧键**不做 PLATFORM_HOSTS
    //        擦洗**（原样输出，安全性来自下方产品域集排平台 host，见 daily-intel spec）。
    const eventsWithKeys: EventWithKeys[] = pushable.map((event) => {
      const url = canonicalUrls.get(event.eventId) ?? null;
      const keys = extractProductMergeKeys({ url });
      return { event, keys };
    });

    //    (b) 产品侧键**无需现提取**：直接读全通道候选携带的**存储三键**（productMergeKeys，由
    //        selectProductCandidates 从 ai_products 存储字段填入），构全通道并集三键集合（满足
    //        Model B channel-blind：只要任一通道会推该产品就剔对应要闻）。**域集 MUST 用命名常量
    //        PLATFORM_HOSTS 排除全部平台 host**——无 website 的 Show HN/PH 产品其 canonical_domain
    //        落成平台 host（producthunt.com/gitlab.com/npmjs.com…），不排除会致该平台 host 的要闻被
    //        mass 误抑制（design D3 一类缺陷）。repos/slugs 不排（走精确键、无平台 host 误抑制问题）。
    const productDomains = new Set<string>();
    const productRepos = new Set<string>();
    const productSlugs = new Set<string>();
    for (const products of productsByChannel.values()) {
      for (const p of products) {
        const k = p.productMergeKeys;
        if (!k) continue; // 事件侧候选不带此字段；理论上产品候选恒带，防御性跳过。
        if (k.canonicalDomain !== null && !PLATFORM_HOSTS.has(k.canonicalDomain)) {
          productDomains.add(k.canonicalDomain);
        }
        if (k.githubRepo !== null) productRepos.add(k.githubRepo);
        if (k.productHuntSlug !== null) productSlugs.add(k.productHuntSlug);
      }
    }

    //    (c) 抑制得 pushableDeduped；后续**早退判断与 dispatch 全改用它**（被剔事件不进 dispatch 的
    //        computePendingSet 入参 → 不写 event push_record → 保留跨天候选资格，次日不再被产品覆盖
    //        即回要闻段，无永久漏推）。
    const { kept: pushableDeduped, suppressedEventIds } = suppressEventsInProducts(
      eventsWithKeys,
      { domains: productDomains, repos: productRepos, slugs: productSlugs },
    );
    if (suppressedEventIds.length > 0) {
      console.error(
        `[pipeline] 跨段去重: 从要闻段抑制 ${suppressedEventIds.length} 条（同项目已在新品段）：` +
          suppressedEventIds.map((id) => id.slice(0, 8)).join(', '),
      );
    }

    // ── 阶段 6：多通道推送（向所有已配置通道并发分发，单消息原子 + push_records 幂等，G6）。
    //    早退：新闻 Top N（**抑制后** pushableDeduped）为空**且**所有 channel 的产品候选皆空才不推
    //    （design D6）；仅一段空时仍推非空段（dispatchDailyDigest 内逐 channel 再判）。
    if (
      pushableDeduped.length === 0 &&
      [...productsByChannel.values()].every((p) => p.length === 0)
    ) {
      // 新闻 Top N 空（摘要分母 = 0 或全被剔除）且所有 channel 产品候选亦空 → 无可推，正常结束
      // （不告警、不中止）。仅一段空不在此早退（落到下方逐 channel dispatch 推非空段）。
      console.error(`[pipeline] 推送: 新闻与产品候选皆空 → skipped-no-candidates`);
      return {
        outcome: 'skipped-no-candidates',
        pushDate,
        collectedCount,
        newsProcessableCount,
        judge: judgeStage,
        digest: digestStage,
        topNCount: topN.length,
        alerted,
        publishedAtBackfill: backfillStats,
        ...(semanticResult ? { semantic: semanticResult } : {}),
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

    // 向**所有已配置通道并发分发**（daily-intel-pipeline / feishu-push）。channelSenders 已在阶段 4
    // 解析（与 selectTopN 候选共用同一通道集）。各通道走 dispatcher 的**双段**状态机
    // dispatchDailyDigest（要闻段 = pushableDeduped〔跨段抑制后〕，新品段 = productsByChannel.get(channel)；
    // 待发集合各按 per-channel 跨天「从未 success」判定）——一条「AI Radar 每日情报」含要闻 + 新品两段、各自幂等。
    console.error(
      `[pipeline] 推送: 待发要闻 ${pushableDeduped.length} 条（跨段抑制后），向 ${channelSenders.length} 个通道并发分发：` +
        channelSenders.map((c) => c.channel).join(', '),
    );

    // **并发分发 + 单通道失败隔离**（Promise.allSettled）：某通道发送失败（dispatch.outcome
    // ='failed' 或 dispatch 自身抛错）只记录该 channel 的 failed、绝不拖垮另一通道——另一通道
    // 照常完成推送。全部 settle 后再统一汇总（成功通道已写 success，失败通道已写 failed）。
    // 产品段 productsByChannel 在阶段 5.5 **算一次**，此处直接复用 .get(channel)、不重算。
    const settled = await Promise.allSettled(
      channelSenders.map(({ channel, sender }) =>
        dispatchDailyDigest(
          pushableDeduped,
          productsByChannel.get(channel) ?? [],
          { now, sender, channel },
          dbh,
        ).then((dispatch): ChannelDispatch => ({ channel, dispatch })),
      ),
    );

    const failedChannels: string[] = [];
    let anySent = false;
    settled.forEach((res, idx) => {
      const channel = channelSenders[idx]!.channel;
      if (res.status === 'fulfilled') {
        const { dispatch } = res.value;
        console.error(`[pipeline] 推送[${channel}]: outcome=${dispatch.outcome}`);
        if (dispatch.outcome === 'failed') failedChannels.push(channel);
        if (dispatch.outcome === 'sent') anySent = true;
      } else {
        // dispatch 抛错（如渲染/DB 异常）：该通道视为失败、隔离，不拖垮另一通道。
        const reason =
          res.reason instanceof Error ? res.reason.message : String(res.reason);
        console.error(`[pipeline] 推送[${channel}]: 异常隔离 ${reason}`);
        failedChannels.push(channel);
      }
    });

    // 任一通道失败 → 整 job 失败（抛错）使 BullMQ 同 push_date 重试。重试时：成功通道的待发
    // 集合 = 今日 Top N MINUS 该 channel 今日已 success（已发不重发，幂等安全）；失败通道的
    // failed 条目重新纳入该 channel 待发集合重发（对齐 telegram-push「failed 下次重试」+ D5/D6）。
    // **分发失败由「单通道隔离 + failed 重试」承载，不计入 judge/摘要熔断分母**（已在前面分别熔断）。
    if (failedChannels.length > 0) {
      throw new Error(
        `digest dispatch failed: push_date=${pushDate} 通道 [${failedChannels.join(', ')}] ` +
          `发送失败（已置 failed），其余通道已完成；抛错使 BullMQ 同日重试失败通道。`,
      );
    }

    // ── 阶段 7：知识库入库（P3 KB 层，spec「知识库准入闸只入精选」/ design D7，6.2）。
    //    **位置约束**：必在 push **成功之后**（无 failedChannels 才到此）——候选 = 当日 `push_records.status
    //    ='success'` 且 `merged_into IS NULL`（非 tombstone）的 event（runKbIngestion 内部据 now→push_date
    //    选候选）。对齐 config 流水线 `Push → KB Ingestion` 顺序，控成本（只入已推送高价值事件）。
    //    **永不向上抛 + 不进熔断分母**：KB 阶段失败绝不污染既有 outcome（已 pushed）/不触发既有熔断/不重试整 job
    //    （push 已 success，整 job 抛错会致 BullMQ 重跑日报、徒增重复 push 风险）。故整段包 try/catch：
    //    runKbIngestion 内部已逐条隔离（Agent/embed/写入失败跳过该条、认领状态感知幂等），此处再兜一层
    //    防御性 catch（如选候选 SELECT 异常），任何异常仅记日志、不抛断、不影响 outcome（语义/KB 层独立于熔断）。
    let kbResult: KbIngestionResult | undefined;
    try {
      kbResult = await runKbIngestion({ now, ...options.kb }, dbh);
      console.error(
        `[pipeline] 知识库入库: 候选 ${kbResult.candidates} 条, Agent 成功 ${kbResult.agentOk}/失败 ${kbResult.agentFailed}, ` +
          `准入闸拦下 ${kbResult.gatedOut} 条, 入库 ${kbResult.ingested} 条, ` +
          `认领跳过 ${kbResult.skippedClaimed} 条, 写入失败 ${kbResult.storeFailed} 条（不计入熔断、不阻塞 outcome）`,
      );
    } catch (error) {
      // 防御性兜底：KB 阶段任何未被内部隔离的异常都不向上抛、不污染已成功的 push outcome。
      console.error(
        `[pipeline] 知识库入库阶段异常（已隔离，不影响日报推送 outcome）`,
        error,
      );
    }

    return {
      // 所有通道均非 failed：有任一 'sent' → pushed；否则（全 skipped，如各通道今日已 success）
      // → skipped-no-candidates。
      outcome: anySent ? 'pushed' : 'skipped-no-candidates',
      pushDate,
      collectedCount,
      newsProcessableCount,
      judge: judgeStage,
      digest: digestStage,
      topNCount: topN.length,
      alerted,
      publishedAtBackfill: backfillStats,
      ...(semanticResult ? { semantic: semanticResult } : {}),
      ...(kbResult ? { kb: kbResult } : {}),
    };
  } finally {
    await lock.release();
  }
}

/**
 * 给日报采集选项注入默认 arXiv 增量游标（at-least-once 接线，source-collectors / design D3）。
 *
 * 仅当调用方**未**自带 arxiv 采集选项时注入固定回溯窗口游标（`createLookbackArxivCursorStore`，
 * 见 arxiv-cursor.ts）——使日报每轮按「近 7 天回溯窗口」增量采集 arXiv（非每轮全量、非固定一点），
 * 无漏窗 + crash-safe 由「窗口重叠 + UNIQUE(source, source_item_id) 幂等」保障，无需持久化游标。
 *
 * 不覆盖调用方注入：测试注入 `collect.arxiv`（自带游标/桩）或 `collect.collectors.arxiv`（mock
 * collector）时原样保留，保证用例对采集行为的精确控制。arXiv 只在日报链注入（实时告警链不采 arXiv）。
 */
function withDefaultArxivCursor(
  collect: CollectAllOptions | undefined,
): CollectAllOptions {
  const base = collect ?? {};
  // 调用方已注入 arxiv 采集选项（含其自带 cursor）→ 原样保留，不覆盖。
  if (base.arxiv !== undefined) return base;
  return { ...base, arxiv: { cursor: createLookbackArxivCursorStore() } };
}

/** 单通道分发结果（供 Promise.allSettled 汇总）。汇总仅读 dispatch.outcome。 */
interface ChannelDispatch {
  channel: Channel;
  dispatch: DailyDispatchResult;
}

/**
 * 解析「已配置通道集 + 各通道 sender」（feishu-push 5.3 / daily-intel-pipeline）。
 *
 * 通道集：默认按 env 计算——恒含 telegram（必配）；isFeishuEnabled() 为真时加 feishu。
 * 可由 options.channels 覆盖（测试用，无需真实 FEISHU env）。
 * 各通道 sender：优先 options.senders[channel]；telegram 兼容 options.sender；
 * 否则按 env 构造真实 sender（telegram→grammY、feishu→webhook）。
 */
function resolveChannelSenders(
  options: RunDailyWorkflowOptions,
): Array<{ channel: Channel; sender: MessageSender }> {
  const channels: Channel[] = options.channels
    ? [...options.channels]
    : isFeishuEnabled()
      ? [CHANNEL.telegram, CHANNEL.feishu]
      : [CHANNEL.telegram];

  return channels.map((channel) => {
    const injected = options.senders?.[channel];
    if (injected) return { channel, sender: injected };
    if (channel === CHANNEL.telegram) {
      return { channel, sender: options.sender ?? createTelegramSender() };
    }
    // channel === 'feishu'：按 env 构造真实 webhook sender（仅在 enabled 时才会走到此处）。
    return { channel, sender: createFeishuSender() };
  });
}
