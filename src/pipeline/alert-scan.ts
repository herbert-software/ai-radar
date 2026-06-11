/**
 * 实时重大发布告警高频工作流（realtime-alerts，design D6）。
 *
 * 一个**独立于 runDailyWorkflow** 的高频轻量工作流（独立 BullMQ 调度入口，频率 env 可配，
 * 默认每 20min）。纯顺序确定性流：
 *   采集（**只跑实时新闻源 {rss, hacker_news, github}**，排除 arXiv 非实时 / PH 配额受限）
 *   → 入库 → 去重塌缩
 *   → 对未评分事件评分（与日报链共用 scoreUnscoredEvents，含并发原子 claim 防双评分）
 *   → **评分后**判 `importance_score IS NOT NULL AND >= 阈值`（默认 85，env 可配，纯程序阈值）
 *   → 对达阈值且「从未以该 channel success 告警过」的事件推送告警
 *
 * 关键不变量（绝不可违背，realtime-alerts / design D6）：
 * - **判定必在评分后**：importance_score 评分前为 NULL（`NULL >= 85` 恒假），阈值判定查 SQL
 *   `importance_score IS NOT NULL AND >= 阈值`——评分阶段已先于本判定执行，绝不以 NULL 误判。
 * - **非 LLM 决定**：是否告警完全由程序阈值决定，禁止 LLM 参与。
 * - **高频链路不套用日报「全源 0」系统级告警**：高频轮询全源 0 / 空轮是常态，本工作流**不调**
 *   classifySystemFailure（否则每天数十次误告警刷屏，见 daily-intel-pipeline）。
 * - **独立四元组**：`target_type='alert'`、`target_id=event_id`、`push_date=触发当日(Asia/Shanghai)`，
 *   与日报 `event` 互不挤占（日报已推同一事件不吞掉告警）。
 * - **一生一次去重**：候选「该 event_id 从未以该 channel success 告警过」管跨天；
 *   `UNIQUE(alert,event_id,channel,push_date)` 兜底同日并发（dispatcher 状态机承载）。
 * - **独立单例锁** `alert:{channel}:{event_id}`：job 级短时持有 + TTL/finally 释放（锁键无时间，
 *   无 TTL 且崩溃未释放会永久死锁该事件告警，故释放语义不可省）。
 * - **failed 告警跨天可重试**：一生一次约束的是 `success` 唯一；failed 当日按 dispatcher 置 failed，
 *   事件仍「从未 success 告警」满足候选窗口，新 push_date 可重试。
 * - **状态机复用**：告警推送复用 dispatcher 同一「待发→pending→原子送达→success/failed」状态机
 *   （含 headline 缺失回退链——告警事件可能尚无中文摘要），仅 target_type/channel 口径不同。
 */
import { and, eq, gte, isNotNull, notExists, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, pushRecords } from '../db/schema.js';
import { env, isFeishuEnabled } from '../config/env.js';
import {
  collectSources,
  REALTIME_NEWS_SOURCES,
  storeCollectedItems,
  type CollectAllOptions,
} from '../collectors/index.js';
import { collapseUncollapsedRawItems } from '../dedup/collapse.js';
import {
  scoreUnscoredEvents,
  type ScoreEventsOptions,
} from '../agents/value-judge/score-events.js';
import {
  dispatchDigest,
  type MessageSender,
} from '../push/dispatcher.js';
import { createTelegramSender } from '../push/telegram.js';
import { createFeishuSender } from '../push/feishu.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { getPushDate } from '../push/push-date.js';
import { acquireAlertLock, type AcquireAlertLockOptions } from './alert-lock.js';

type DbLike = typeof defaultDb;

/** 告警 sink（仅用于运行期可观测日志；高频链路**不**做日报式系统级告警）。 */
export type AlertLogSink = (message: string, detail?: unknown) => void;

const defaultLog: AlertLogSink = (message, detail) =>
  console.error(`[alert-scan] ${message}`, detail ?? '');

export interface RunAlertScanOptions {
  /** 参考时刻，决定 push_date（告警触发当日，Asia/Shanghai）（默认当前时刻）。 */
  now?: Date;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /** 采集层选项（注入 mock collector）。仅作用于实时新闻源子集。 */
  collect?: CollectAllOptions;
  /** Value Judge 评分阶段选项（注入 mock generateObject、reclaimMs 等）。 */
  judge?: ScoreEventsOptions;
  /** 告警阈值覆盖（默认 env.ALERT_IMPORTANCE_THRESHOLD）。 */
  threshold?: number;
  /**
   * 覆盖「已配置通道集」（测试用）。默认按 env：恒含 telegram，isFeishuEnabled() 为真加 feishu。
   */
  channels?: readonly Channel[];
  /** 各通道发送器显式注入（测试注入 mock）；否则按 env 构造真实 sender。 */
  senders?: Partial<Record<Channel, MessageSender>>;
  /** 告警单例锁选项（注入 mock Redis / TTL）。 */
  lock?: AcquireAlertLockOptions;
  /** 运行期日志 sink（默认 console.error）。 */
  log?: AlertLogSink;
}

/** 单条告警的发送结果。 */
export interface AlertDispatchOutcome {
  eventId: string;
  channel: Channel;
  /** 'sent' 已告警 / 'failed' 发送失败（跨天可重试）/ 'skipped-locked' 未抢到单例锁 /
   *  'skipped' 待发为空（同日已 success 或并发 UNIQUE 兜底）。 */
  outcome: 'sent' | 'failed' | 'skipped-locked' | 'skipped';
}

/** 高频告警工作流结果（供 worker / 可观测 / 测试断言）。 */
export interface RunAlertScanResult {
  pushDate: string;
  /** 实时新闻源采集返回条数（不含 arXiv/PH，那两源本链路不采）。 */
  collectedCount: number;
  /** 本轮评分阶段实际送判数（claim 成功）。 */
  judged: number;
  /** 评分后达阈值且「从未以该 channel success 告警」的候选事件数（去重后、按事件计）。 */
  alertCandidateCount: number;
  /** 各通道各事件的告警发送结果。 */
  dispatched: AlertDispatchOutcome[];
}

/** 评分后达阈值告警候选的最小视图（供拼告警消息 + 渲染回退链）。 */
interface AlertCandidate {
  eventId: string;
  representativeTitle: string | null;
  summaryZh: string | null;
  headlineZh: string | null;
  publishedAt: Date | null;
  canonicalUrl: string | null;
}

/**
 * 查「评分后达阈值且从未以任一通道 success 告警过」的候选事件（realtime-alerts 一生一次）。
 *
 * 条件（全在 SQL 程序层，无 LLM）：
 *   importance_score IS NOT NULL AND importance_score >= 阈值   ← 判定必在评分后（NULL 不误判）
 *   AND NOT EXISTS (push_records WHERE target_type='alert' AND target_id=event_id
 *                     AND status='success')   ← 任一通道从未 success 告警（channel-agnostic）
 *
 * **统一模型（Model B）**：选题与通道解耦——channel-agnostic 选出「该告警的事件」，再由 runAlertScan
 * 同份发放给所有已配置通道（通道只负责投递上游统一选好的信息）。跨天去重靠「从未 success（任一通道）」
 * 候选窗口；同日并发由 `UNIQUE(alert,event_id,channel,push_date)` 兜底（dispatcher 状态机）。
 * canonical_url 经 representative_raw_item_id 回指 raw_items（供告警消息渲染原文链接）。
 */
export async function selectAlertCandidates(
  threshold: number,
  dbh: DbLike = defaultDb,
): Promise<AlertCandidate[]> {
  const neverAlerted = notExists(
    dbh
      .select({ one: sql`1` })
      .from(pushRecords)
      .where(
        and(
          eq(pushRecords.targetType, TARGET_TYPE.alert),
          eq(pushRecords.targetId, aiNewsEvents.eventId),
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
    })
    .from(aiNewsEvents)
    .where(
      and(
        // 判定必在评分后：importance_score 非 NULL（评分前为 NULL，`NULL >= 阈值` 恒假，不误判）。
        isNotNull(aiNewsEvents.importanceScore),
        gte(aiNewsEvents.importanceScore, String(threshold)),
        neverAlerted,
      ),
    );

  return rows.map((r) => ({
    eventId: r.eventId,
    representativeTitle: r.representativeTitle,
    summaryZh: r.summaryZh,
    headlineZh: r.headlineZh,
    publishedAt: r.publishedAt,
    canonicalUrl: null, // 告警渲染回退链可无链接；canonicalUrl 由调用方按需补（本期保守置 null）。
  }));
}

/** 把告警候选映射为 dispatcher 输入的 SelectedEvent（headline 缺失走 dispatcher 渲染回退链）。 */
function toSelectedEvent(c: AlertCandidate): SelectedEvent {
  return {
    eventId: c.eventId,
    representativeTitle: c.representativeTitle,
    summaryZh: c.summaryZh,
    headlineZh: c.headlineZh,
    canonicalUrl: c.canonicalUrl,
    publishedAt: c.publishedAt,
    rankScore: 0, // 告警不排序；占位。
  };
}

/**
 * 解析「已配置通道集 + 各通道 sender」（同 run-daily-workflow，告警链复用同一通道集口径）。
 */
function resolveChannelSenders(
  options: RunAlertScanOptions,
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
      return { channel, sender: createTelegramSender() };
    }
    return { channel, sender: createFeishuSender() };
  });
}

/**
 * 跑一次实时告警高频扫描（纯顺序）。
 *
 * @param options 注入点（now / db / collect mock / judge mock / threshold / channels / senders / lock / log）。
 */
export async function runAlertScan(
  options: RunAlertScanOptions = {},
): Promise<RunAlertScanResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const log = options.log ?? defaultLog;
  const threshold = options.threshold ?? env.ALERT_IMPORTANCE_THRESHOLD;
  const pushDate = getPushDate(now);

  // ── 阶段 1：采集（**只跑实时新闻源 {rss, hacker_news, github}**，排除 arXiv/PH）+ 入库。
  // 高频链路全源 0 / 空轮是常态：**不**调 classifySystemFailure 做系统级告警（防刷屏）。
  const collected = await collectSources(REALTIME_NEWS_SOURCES, {
    ...options.collect,
  });
  const collectedCount = collected.items.length;
  await storeCollectedItems(collected.items, { dbh });
  log(`实时源采集: 返回 ${collectedCount} 条（仅 ${REALTIME_NEWS_SOURCES.join('/')}）`);

  // ── 阶段 2：去重塌缩（与日报链共用 collapseUncollapsedRawItems，按 collapsed 标记驱动、幂等）。
  await collapseUncollapsedRawItems(dbh);

  // ── 阶段 3：对未评分事件评分（与日报链共用，含并发原子 claim 防双评分）。
  //    评分必在阈值判定**之前**：保证下一步判定时 importance_score 已写（不 NULL 误判）。
  const judgeResult = await scoreUnscoredEvents(options.judge, dbh);
  log(
    `评分: 送判 ${judgeResult.judged} 条, 降级 ${judgeResult.degradedCount} 条, claim 跳过 ${judgeResult.claimSkipped} 条`,
  );

  // ── 阶段 4：评分**后**判阈值 + 推送告警（纯程序阈值，非 LLM 决定）。
  // **统一模型（Model B）**：channel-agnostic 选一次告警事件，每个事件**同份发放给所有已配置通道**
  // （通道只负责投递上游统一选好的信息，不参与选题）。
  const channelSenders = resolveChannelSenders(options);
  const dispatched: AlertDispatchOutcome[] = [];

  // channel-agnostic 候选：达阈值且从未以任一通道 success 告警过（一生一次、跨天去重）。
  const candidates = await selectAlertCandidates(threshold, dbh);
  log(
    `告警候选: ${candidates.length} 条达阈值(>=${threshold})且从未 success 告警，` +
      `发放给 ${channelSenders.length} 个通道（${channelSenders.map((c) => c.channel).join(', ')}）`,
  );

  for (const candidate of candidates) {
    // 独立单例锁 `alert:{event_id}`（per-event，覆盖该事件的多通道分发）：防两并发 alert-scan
    // 实例对同一告警事件重复分发（UNIQUE 挡不住并发双读双发）。job 级短时持有 + TTL/finally
    // 释放（锁键无时间，释放不可省）。未抢到 → 另一实例在发该事件，本实例跳过（不重复）。
    const lock = await acquireAlertLock(candidate.eventId, options.lock);
    if (lock === null) {
      log(`告警跳过[${candidate.eventId}]: 未抢到单例锁`);
      for (const { channel } of channelSenders) {
        dispatched.push({ eventId: candidate.eventId, channel, outcome: 'skipped-locked' });
      }
      continue;
    }
    try {
      // 同份发放给所有已配置通道：各通道复用 dispatcher 同一状态机（target_type='alert'、按事件
      // 单独成名单），各通道 computePendingSet + UNIQUE 同日幂等独立；渲染走 message.ts 的 headline
      // 回退链（headline_zh → summary_zh 截断 → representative_title → 仅标题），无摘要不报错/不漏告警。
      // 单通道发送失败隔离（各自 try/catch），不拖垮该事件的其余通道。
      for (const { channel, sender } of channelSenders) {
        try {
          const result = await dispatchDigest(
            [toSelectedEvent(candidate)],
            { now, sender, channel, targetType: TARGET_TYPE.alert },
            dbh,
          );
          dispatched.push({
            eventId: candidate.eventId,
            channel,
            outcome: result.outcome === 'sent' ? 'sent'
              : result.outcome === 'failed' ? 'failed'
              : 'skipped',
          });
          log(`告警[${channel}][${candidate.eventId}]: outcome=${result.outcome}`);
        } catch (error) {
          // dispatch 自身抛错（如渲染/DB 异常）：记为 failed（跨天可重试），隔离不拖垮其余通道。
          const reason = error instanceof Error ? error.message : String(error);
          log(`告警[${channel}][${candidate.eventId}]: 异常隔离 ${reason}`, error);
          dispatched.push({ eventId: candidate.eventId, channel, outcome: 'failed' });
        }
      }
    } finally {
      await lock.release();
    }
  }

  return {
    pushDate,
    collectedCount,
    judged: judgeResult.judged,
    alertCandidateCount: candidates.length,
    dispatched,
  };
}
