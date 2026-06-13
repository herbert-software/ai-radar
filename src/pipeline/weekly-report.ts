/**
 * 周报定时汇总与推送（任务 10.1 / 10.2 / 10.3，weekly-report「周报定时汇总与推送」/
 * 「周报推送幂等按周粒度」，design D6）。
 *
 * **独立周级调度任务（对齐 daily-intel-pipeline，绝不塞进 runDailyWorkflow / 日报队列）**：
 * 周报是与日报、产品发现并列的独立 BullMQ 调度入口，其**内部**是一条顺序子流程
 *   选高价值事件/产品名单（程序规则，复用已落库摘要，不触 LLM）→ 推送（复用 dispatcher 同一状态机）
 * 但整体独立于日报链运行（见本文件 queue/worker 工厂）。
 *
 * 关键不变量（绝不可违背，weekly-report spec / design D6）：
 *
 * - **窗口与 iso_week/push_date 同源锚定「被汇总窗口」**：
 *   窗口 = `[上周一 00:00, 本周一 00:00)`（Asia/Shanghai），其中 `本周一` = 触发时刻所在 ISO 周的
 *   周一 00:00（与触发 weekday 无关）。**禁用滚动 7×24h 窗口**——滚动窗口与 ISO 周边界不一致，
 *   会使周一前后两次触发落在不同 iso_week 却覆盖高度重叠内容、把重复内容跨周各推一次。
 *   `iso_week` 与 `push_date` **都取「被汇总窗口 `[上周一, 本周一)` 对应的那个 ISO 周」**（即「刚结束
 *   的完整一周」= 上周）的标签与其周一日期——**不取触发时刻所在周**。否则触发时刻在周边界附近抖动
 *   会使 target_id 与 push_date 指向不同周、错配（UNIQUE 仍唯一但幂等语义漂移）。本模块用
 *   weeklyAnchor() 一次性算出窗口下界/上界 + iso_week + push_date，**同源**，杜绝两处口径漂移。
 *   同源保证：`push_date` 恒等于 `iso_week` 对应的周一日期；任一 ISO 周内任意时刻触发都得到
 *   相同的 (iso_week, push_date, window)。
 *
 * - **幂等四元组**：`target_type='weekly'`、`target_id=iso_week`（如 `2026-W23`）、`channel`、
 *   `push_date=该 ISO 周周一（Asia/Shanghai）`。独立 `target_type='weekly'` 使周报与日报
 *   （`event`）、产品（`product`）、告警（`alert`）在 push_records 互不挤占。
 *   「同一周不重复推」由 `UNIQUE(weekly, iso_week, channel, push_date)` 兜底（冲突即跳过）。
 *
 * - **复用 dispatcher 同一套状态机核心**（待发→pending→原子送达→success/failed），仅 target_type
 *   与幂等键口径不同，**禁止另写一套漂移的状态机**。周报 push_date 不是「触发当日」而是「汇总周周一」，
 *   故向 dispatcher 注入一个落在汇总周周一（Shanghai）的合成参考时刻 `dispatchNow`，使其内部
 *   `getPushDate(dispatchNow)` 恰好得到锚定的 push_date（复用同一 push-date 时区源、不绕过状态机）。
 *
 * - **周报名单与排序由程序规则决定，禁止由 LLM 决定最终名单**；每条中文摘要复用已落库的
 *   `summary_zh`/`headline_zh`，**不重复触发逐条 LLM 调用**（本模块零 LLM 调用）。
 *
 * - **产品选入复用每日产品推送的 merge_conflict 排除谓词**（`metadata->'merge_conflict' IS NULL`），
 *   排除标记冲突的多个 product_id，避免同一真实产品散为多行在周报正文重复列出。
 *
 * - **独立单例锁** `weekly:{channel}:{iso_week}`（job 级短时持有 + TTL/finally 释放），防两并发实例
 *   各读待发集合各发一条（UNIQUE 挡不住此并发）。锁键不含时间故释放语义不可省（同 telegram-push
 *   单例锁要求）。锁键用 `iso_week`（汇总周）而非触发周，与四元组同源。
 *
 * - **触发时刻避整点/半点**降低飞书限流（默认 cron 见 DEFAULT_WEEKLY_CRON）。
 *
 * 文件归属边界：本文件只调用/引用 dispatcher / targets / push-date / product-digest 已导出函数与
 * schema，不重写其逻辑、不改 schema；周报候选查询在本文件用程序条件表达。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, aiProducts } from '../db/schema.js';
import { env, isFeishuEnabled } from '../config/env.js';
import {
  dispatchDigest,
  type DispatchResult,
  type MessageSender,
} from '../push/dispatcher.js';
import {
  computeRankScore,
  rankAndSelect,
  type RankWeights,
  type SelectedEvent,
} from '../selection/top-n.js';
import { createTelegramSender } from '../push/telegram.js';
import { createFeishuSender } from '../push/feishu.js';
import type { WeeklySelectedEvent } from '../push/message.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';
import { dateInTimeZone, startOfDayInTimeZone } from '../push/push-date.js';
import { buildConnection } from './queue.js';

type DbLike = typeof defaultDb;

/**
 * 周报默认 cron（BullMQ repeat.pattern）：每周一 09:07（Asia/Shanghai）。
 * **分钟字段避整点/半点（∉ {0,30}）**降低飞书限流（同日报 DAILY_DIGEST_CRON 默认意图）；
 * 周一触发使汇总窗口恰为「刚结束的完整一周」（上周一→本周一）。
 *
 * 注：周报 cron 配置未引入新 env（本组文件归属边界禁改 config/env.ts）；用本常量作默认，
 * 可经 scheduleWeeklyReport 的 cron/tz 参数覆盖（wiring 层注入）。cron 时区默认与 push_date
 * 同源 Asia/Shanghai，防触发时区与汇总周口径漂移。
 */
export const DEFAULT_WEEKLY_CRON = '7 9 * * 1';
/** 周报 cron 时区（与 push_date 同源 Asia/Shanghai，防漂移）。 */
export const DEFAULT_WEEKLY_CRON_TZ = 'Asia/Shanghai';

/**
 * 周报推送单例锁默认 TTL（毫秒）：10 分钟。覆盖单 channel 一次周报 dispatch 最坏时长
 * （拼一条消息 + 一次外部发送 + 状态机写库）。周报名单为程序选取、复用已落库摘要，
 * **不含逐条 LLM 调用**，故与产品推送同口径取 10min（短于日报 30min）。崩溃时该 TTL 是
 * 「同 channel 同 iso_week 重新获取锁」的恢复上界。
 */
const DEFAULT_WEEKLY_LOCK_TTL_MS = 10 * 60 * 1000;

/** 周报队列名（独立于 daily-digest / product-digest，绝不复用）。 */
export const WEEKLY_REPORT_QUEUE = 'weekly-report';
/** 周报 job 名。 */
export const WEEKLY_REPORT_JOB = 'weekly-report';
/** cron 重复任务稳定标识，防重复注册同一 cron。 */
const WEEKLY_CRON_JOB_ID = 'weekly-report-cron';

// ──────────────────────────────────────────────────────────────────────────
// 周锚点：窗口下界/上界 + iso_week + push_date（同源，禁两处口径漂移）
// ──────────────────────────────────────────────────────────────────────────

/** 周报锚点：被汇总窗口 `[lowerBound, upperBound)` + 同源 iso_week + push_date。 */
export interface WeeklyAnchor {
  /** 窗口下界（含）：上周一 00:00（Asia/Shanghai）对应的 UTC 时刻。 */
  windowStart: Date;
  /** 窗口上界（不含）：本周一 00:00（Asia/Shanghai）对应的 UTC 时刻。 */
  windowEnd: Date;
  /** ISO 周标签（被汇总窗口对应周，即上周），如 `2026-W23`。target_id 用它。 */
  isoWeek: string;
  /** 被汇总窗口对应周（上周）的周一日期串 `YYYY-MM-DD`（Asia/Shanghai）。push_date 用它。 */
  pushDate: string;
}

/**
 * 计算「`at` 所在 Shanghai 自然日是星期几」（1=周一 … 7=周日，ISO weekday）。
 *
 * **不可**用 `startOfDayInTimeZone(at,0).getUTCDay()`——那个 UTC 时刻（如 06-08 00:00 SH = 06-07
 * 16:00 UTC）落在前一个 UTC 自然日、其 UTC 星期被错移一天。改为：取 `at` 的 Shanghai 日期串
 * `YYYY-MM-DD`，把同一组 Y/M/D 当作 **UTC 正午**构造 Date 再 getUTCDay()——正午绝不跨日，UTC 星期
 * 即等于该 Shanghai 自然日的星期，不受时区/夏令时影响。
 */
function isoWeekdayOfShanghaiDay(at: Date): number {
  const [y, m, d] = dateInTimeZone(at).split('-').map((p) => Number(p));
  const noonUtc = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  const dow = noonUtc.getUTCDay(); // 0=周日 … 6=周六
  return dow === 0 ? 7 : dow; // 转 ISO：1=周一 … 7=周日
}

/**
 * 计算 ISO 8601 周标签 `GGGG-Www`（如 `2026-W23`）。
 *
 * 入参 `mondayUtc` 必须是某 ISO 周周一 00:00（Shanghai）对应的 UTC 时刻（由 weeklyAnchor 保证）。
 * ISO 周归属以「该周的周四」所在公历年为准（ISO 8601 规则：含 1 月 4 日的周为第 1 周）。
 * 据周一日期 `YYYY-MM-DD`（Shanghai）纯日期算法计算，不依赖宿主机时区。
 */
export function isoWeekLabel(mondayDateStr: string): string {
  const [y, m, d] = mondayDateStr.split('-').map((p) => Number(p));
  // 以该周周一为基准，加 3 天得周四——周四所在公历年即 ISO 周年。
  const monday = new Date(Date.UTC(y!, m! - 1, d!));
  const thursday = new Date(monday.getTime() + 3 * 24 * 3600 * 1000);
  const isoYear = thursday.getUTCFullYear();
  // 该 ISO 年第 1 周的周四 = 含 1 月 4 日的那周的周四。
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay(); // ISO weekday
  const week1Thursday = new Date(
    jan4.getTime() + (4 - jan4Dow) * 24 * 3600 * 1000,
  );
  const weekNum =
    Math.round(
      (thursday.getTime() - week1Thursday.getTime()) / (7 * 24 * 3600 * 1000),
    ) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * 据触发时刻 `at` 计算周报锚点（窗口 + iso_week + push_date，**同源**）。
 *
 * 步骤：
 *   ① 求 `at` 所在 Shanghai 自然日的 ISO weekday（1..7）；
 *   ② `本周一` = `at` 当周周一 00:00（Shanghai）= startOfDayInTimeZone(at, weekday−1)；
 *   ③ `上周一` = 本周一往前 7 天 00:00（Shanghai）= startOfDayInTimeZone(本周一−ε, 7) 的等价：
 *      直接 startOfDayInTimeZone(at, weekday−1+7)；
 *   ④ 窗口 = `[上周一, 本周一)`；iso_week/push_date 取**上周一**（被汇总窗口对应周）。
 *
 * 同源保证：iso_week 由上周一日期算（isoWeekLabel(上周一)），push_date = 上周一日期串，二者均源自
 * 同一个上周一锚点 → 恒一致、不随触发时刻在周内抖动而漂移。任一 ISO 周内任意时刻触发得相同锚点。
 *
 * @param at 触发参考时刻（默认当前时刻）。
 */
export function weeklyAnchor(at: Date = new Date()): WeeklyAnchor {
  const weekday = isoWeekdayOfShanghaiDay(at); // 1=周一 … 7=周日
  // 本周一 00:00（Shanghai）的 UTC 时刻：往前推 (weekday−1) 个 Shanghai 自然日。
  const windowEnd = startOfDayInTimeZone(at, weekday - 1);
  // 上周一 00:00（Shanghai）的 UTC 时刻：再往前 7 天（共 weekday−1+7 个自然日）。
  const windowStart = startOfDayInTimeZone(at, weekday - 1 + 7);
  // push_date = 上周一（Shanghai）日期串：把 windowStart（上周一 00:00 UTC 锚点）+12h 折算回
  // Shanghai 日期，得稳定的上周一 YYYY-MM-DD（避开 00:00 边界折算抖动）。
  const pushDate = dateInTimeZone(
    new Date(windowStart.getTime() + 12 * 3600 * 1000),
  );
  const isoWeek = isoWeekLabel(pushDate);
  return { windowStart, windowEnd, isoWeek, pushDate };
}

// ──────────────────────────────────────────────────────────────────────────
// 候选查询：程序规则选周报名单（非 LLM），复用已落库 summary_zh/headline_zh
// ──────────────────────────────────────────────────────────────────────────

function defaultWeights(): RankWeights {
  return {
    importance: env.RANK_WEIGHT_IMPORTANCE,
    developerRelevance: env.RANK_WEIGHT_DEVELOPER_RELEVANCE,
    novelty: env.RANK_WEIGHT_NOVELTY,
    hypeRisk: env.RANK_WEIGHT_HYPE_RISK,
  };
}

/** NUMERIC 列经 Drizzle 读回为字符串，统一转 number；NULL → 0。 */
function toNum(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 选周报内的高价值**事件**（程序规则，**非 LLM**）。
 *
 * 候选条件（全在 SQL 层用程序条件表达）：
 * - `should_push = true`（已被 Value Judge 判为可推）；
 * - `first_seen_at` 落在被汇总窗口 `[windowStart, windowEnd)`（**绝非滚动 7×24h**——窗口由
 *   weeklyAnchor 按 ISO 周边界锚定）；
 * - `importance_score >= floor`（下限闸，复用日报 env.IMPORTANCE_FLOOR）。
 *
 * 排序与取前 N 在程序内完成（rankAndSelect / computeRankScore，与日报同口径），**不交 LLM**。
 * 每条复用已落库 `summary_zh`/`headline_zh`（不触发 LLM）；周报渲染层据此拼正文。
 *
 * 注：周报「同一周不重复推」由 UNIQUE 四元组兜底（target_id=iso_week）；不像日报候选那样按
 * 「从未以该 channel success」跨天去重——周报幂等粒度是「一周一份」，UNIQUE 已足够。
 */
export async function selectWeeklyEvents(
  anchor: WeeklyAnchor,
  dbh: DbLike = defaultDb,
  limit: number = env.TOP_N,
  importanceFloor: number = env.IMPORTANCE_FLOOR,
  weights: RankWeights = defaultWeights(),
): Promise<SelectedEvent[]> {
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
        // 被汇总窗口 [windowStart, windowEnd)（左闭右开，ISO 周边界，禁滚动 7×24h）。
        // ⚠️ 启用前必改（跟踪项，fix-push-recency-by-published-at design D6 / proposal 非目标）：
        // 周报汇总窗口仍键于 `first_seen_at`（抓取时刻），与日报/告警已修复的同一根因 bug 未根治——
        // first_seen_at 是 raw_item 入库时刻、与文章真实发布时间无关；冷启动/新增源时历史老文的
        // first_seen_at 恰落进本周窗口，会重演「把历史老文当本周内容刷屏」的 bug。
        // weekly-report 当前默认禁用（WEEKLY_REPORT_ENABLED=false），本期 scope-out；但**重新启用前**
        // 必须先把下面两行的窗口键由 `firstSeenAt` 改为 `publishedAt`（同口径 NULL 处理：NULL 经 AI
        // 推断回填、仍 NULL 则排除，参见 top-n.ts / alert-scan.ts 与 published-at-inference 模块），
        // 否则会重蹈本 bug。勿静默遗忘。
        gte(aiNewsEvents.firstSeenAt, anchor.windowStart),
        lt(aiNewsEvents.firstSeenAt, anchor.windowEnd),
        // 下限闸：NULL importance 被 gte 自然排除。
        gte(aiNewsEvents.importanceScore, String(importanceFloor)),
      ),
    );

  const candidates: SelectedEvent[] = rows.map((r) => ({
    eventId: r.eventId,
    representativeTitle: r.representativeTitle,
    // 复用已落库摘要（不触 LLM）。
    summaryZh: r.summaryZh,
    headlineZh: r.headlineZh,
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

  return rankAndSelect(candidates, limit);
}

/**
 * 选周报内的高价值**产品**（程序规则，**非 LLM**）。
 *
 * 候选条件（全在 SQL 层用程序条件表达）：
 * - **复用每日产品推送的 merge_conflict 排除谓词**（`metadata->'merge_conflict' IS NULL`）：被标记
 *   冲突的同一真实产品散为多个 product_id，会在周报正文重复列出，故排除（与 product-digest 一致）。
 * - `last_seen_at` 落在被汇总窗口 `[windowStart, windowEnd)`（该周内仍活跃/上榜的产品）。
 *
 * 按 last_seen_at DESC 取前 N（确定性 tiebreaker：product_id ASC）。产品无摘要，summary/headline
 * 置 null 走渲染回退（仅标题）。
 */
export async function selectWeeklyProducts(
  anchor: WeeklyAnchor,
  dbh: DbLike = defaultDb,
  limit: number = env.TOP_N,
): Promise<SelectedEvent[]> {
  const rows = await dbh
    .select({
      productId: aiProducts.productId,
      name: aiProducts.name,
      lastSeenAt: aiProducts.lastSeenAt,
    })
    .from(aiProducts)
    .where(
      and(
        // 排除 merge_conflict（复用每日产品推送排除谓词，spec 10.1）。
        isNull(sql`${aiProducts.metadata} -> 'merge_conflict'`),
        // 被汇总窗口内仍活跃的产品（last_seen_at ∈ [windowStart, windowEnd)）。
        gte(aiProducts.lastSeenAt, anchor.windowStart),
        lt(aiProducts.lastSeenAt, anchor.windowEnd),
      ),
    )
    .orderBy(sql`${aiProducts.lastSeenAt} DESC NULLS LAST`, aiProducts.productId)
    .limit(limit);

  return rows.map((r) => ({
    eventId: r.productId,
    representativeTitle: r.name,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// 独立单例锁：weekly:{channel}:{iso_week}
// ──────────────────────────────────────────────────────────────────────────

/** 最小 Redis 能力面（便于集成测注入内存桩；真实用 ioredis）。与 lock.ts / product-digest 同形。 */
export interface WeeklyLockRedis {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

/** 已持有的周报推送锁句柄；释放时核对令牌防误删他人锁。 */
export interface WeeklyReportLock {
  readonly key: string;
  /** 释放锁（核对令牌后删除）。重复调用安全。 */
  release(): Promise<void>;
}

export interface AcquireWeeklyLockOptions {
  /** 注入 Redis（默认按 env.REDIS_URL 新建一次性短连接）。 */
  redis?: WeeklyLockRedis;
  /** 锁 TTL（毫秒），默认 10 分钟。须覆盖单 channel 一次周报 dispatch 最坏时长。 */
  ttlMs?: number;
}

// 「核对令牌再删」——只删自己持有的锁，避免锁过期被他人重获后误删。
const WEEKLY_RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/** 周报推送锁键：`weekly:{channel}:{iso_week}`（独立命名空间；iso_week 与四元组同源、不含触发时间）。 */
export function weeklyLockKey(channel: Channel, isoWeek: string): string {
  return `weekly:${channel}:${isoWeek}`;
}

/**
 * 尝试获取某 (channel, iso_week) 的周报推送单例锁。
 *
 * 成功 → 返回 WeeklyReportLock（带 finally release）；已被他人持有 → 返回 null（调用方放弃该通道）。
 * 必须带 TTL（崩溃兜底）+ finally release（正常路径）。锁键含 iso_week（汇总周）而非触发时间，无 TTL
 * 且崩溃未释放会永久死锁该 (channel, iso_week)，故释放语义不可省。job 级短时持有、无需看门狗续租。
 */
export async function acquireWeeklyReportLock(
  channel: Channel,
  isoWeek: string,
  options: AcquireWeeklyLockOptions = {},
): Promise<WeeklyReportLock | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_WEEKLY_LOCK_TTL_MS;
  const key = weeklyLockKey(channel, isoWeek);
  const token = randomUUID();

  const ownsConnection = !options.redis;
  const redis: WeeklyLockRedis =
    options.redis ??
    (new Redis(env.REDIS_URL, { commandTimeout: 5000 }) as unknown as WeeklyLockRedis);

  let acquired: 'OK' | null;
  try {
    acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  } catch (error) {
    if (ownsConnection) (redis as unknown as Redis).disconnect();
    throw error;
  }

  if (acquired !== 'OK') {
    if (ownsConnection) (redis as unknown as Redis).disconnect();
    return null;
  }

  let released = false;
  return {
    key,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await redis.eval(WEEKLY_RELEASE_SCRIPT, 1, key, token);
      } finally {
        if (ownsConnection) (redis as unknown as Redis).disconnect();
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 周报 workflow（顺序子流程：算锚点 → 选名单（事件+产品）→ 推送）
// ──────────────────────────────────────────────────────────────────────────

/** 单通道分发结果（供汇总/可观测/测试断言）。 */
export interface WeeklyChannelOutcome {
  channel: Channel;
  /** 'sent'/'failed'/'skipped' 同 dispatcher；'locked' = 未抢到该 channel 单例锁本实例放弃。 */
  outcome: DispatchResult['outcome'] | 'locked';
  /** 本次实际发出的 target_id 列表（即 iso_week 维度下入选条目，locked/skipped 为空）。 */
  targetIds: string[];
}

export interface RunWeeklyReportOptions {
  /** 触发参考时刻，决定汇总周锚点（默认当前时刻）。 */
  now?: Date;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /**
   * 各通道发送器显式注入（多通道分发）。未提供某已配置通道的 sender 时按 env 构造真实 sender。
   */
  senders?: Partial<Record<Channel, MessageSender>>;
  /**
   * 覆盖「已配置通道集」（测试用，无需真实 FEISHU env）。默认按 env 计算：恒含 telegram；
   * isFeishuEnabled() 为真时加 feishu。
   */
  channels?: readonly Channel[];
  /** 周报推送单例锁选项（注入 mock Redis / TTL）。 */
  lock?: AcquireWeeklyLockOptions;
  /** 事件/产品候选各取前 N 条（默认 env.TOP_N）。 */
  limit?: number;
}

export interface RunWeeklyReportResult {
  /** 被汇总窗口对应周的周一日期（push_date，YYYY-MM-DD，Shanghai）。 */
  pushDate: string;
  /** 被汇总窗口对应周的 ISO 周标签（target_id，如 2026-W23）。 */
  isoWeek: string;
  /** 周报正文入选事件数。 */
  eventCount: number;
  /** 周报正文入选产品数。 */
  productCount: number;
  /** 各通道分发结果。 */
  channels: WeeklyChannelOutcome[];
}

/**
 * 解析「已配置通道集 + 各通道 sender」（与 run-daily-workflow / product-digest 同口径）。
 * 通道集：默认恒含 telegram；isFeishuEnabled() 为真加 feishu；可由 options.channels 覆盖。
 * sender：优先 options.senders[channel]；否则按 env 构造真实 sender。
 */
function resolveChannelSenders(
  options: RunWeeklyReportOptions,
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
 * 把 push_date（YYYY-MM-DD，Shanghai 的汇总周周一）折算成一个落在该日中午（Shanghai）的合成 UTC
 * 时刻，供注入给 dispatcher 的 `now`——使 dispatcher 内部 `getPushDate(now)` 恰好返回该 push_date。
 *
 * 这样周报推送的幂等四元组 push_date = 汇总周周一（**非触发当日**），同时仍**完全复用 dispatcher
 * 同一套状态机核心**（不绕过、不另写）。取中午（+12h）避开 00:00 边界折算抖动。
 */
function dispatchNowForPushDate(pushDate: string): Date {
  const [y, m, d] = pushDate.split('-').map((p) => Number(p));
  // startOfDayInTimeZone 需要一个落在目标 Shanghai 自然日的参考时刻；用该日 12:00 UTC 作种子
  // 再取其 Shanghai 当日 00:00，最后 +12h 落到该日中午（Shanghai）。
  const seed = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  const localMidnightUtc = startOfDayInTimeZone(seed, 0);
  return new Date(localMidnightUtc.getTime() + 12 * 3600 * 1000);
}

/**
 * 跑一次完整周报（顺序子流程：算锚点 → 选名单（事件+产品）→ 推送）。
 *
 * 锚点由 weeklyAnchor(now) 一次性算出（窗口 + iso_week + push_date 同源）。每个 channel 各自独立
 * 单例锁 `weekly:{channel}:{iso_week}`（job 级 + finally 释放），锁内：选该 channel 名单（事件+产品
 * 合并）→ dispatch（复用同一状态机，target_type='weekly'、target_id=iso_week、push_date=汇总周周一）。
 * 某 channel 未抢到锁则 outcome='locked' 本实例放弃该通道（不拖垮其余通道）。
 *
 * **target_id=iso_week 关键**：dispatcher 的 target_id 取自 SelectedEvent.eventId。周报四元组的
 * target_id 必须是 iso_week（一周一份），故传给 dispatcher 的名单是**单条** eventId=iso_week 的
 * 汇总条目，其渲染正文由周报渲染器（message.ts weekly 分支）展开事件+产品列表。
 *
 * @param options 注入点（now / db / sender / 通道集 / 锁 / limit）。
 */
export async function runWeeklyReport(
  options: RunWeeklyReportOptions = {},
): Promise<RunWeeklyReportResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const limit = options.limit ?? env.TOP_N;

  // 锚点：窗口 + iso_week + push_date 同源（防跨周边界抖动错配）。
  const anchor = weeklyAnchor(now);
  // dispatcher 内部按注入的 now 算 push_date；注入落在汇总周周一中午的合成时刻使其 = anchor.pushDate。
  const dispatchNow = dispatchNowForPushDate(anchor.pushDate);

  const channelSenders = resolveChannelSenders(options);
  const channels: WeeklyChannelOutcome[] = [];

  let eventCount = 0;
  let productCount = 0;

  for (const { channel, sender } of channelSenders) {
    // 独立单例锁 weekly:{channel}:{iso_week}（防两并发实例各发一条）。锁键用汇总周 iso_week。
    const lock = await acquireWeeklyReportLock(channel, anchor.isoWeek, options.lock);
    if (lock === null) {
      console.error(
        `[weekly-report] 锁: ${channel} iso_week=${anchor.isoWeek} 未抢到单例锁，本实例放弃该通道`,
      );
      channels.push({ channel, outcome: 'locked', targetIds: [] });
      continue;
    }

    try {
      // 程序规则选名单（事件 + 产品），复用已落库 summary_zh/headline_zh，**零 LLM 调用**。
      const events = await selectWeeklyEvents(anchor, dbh, limit);
      const products = await selectWeeklyProducts(anchor, dbh, limit);
      eventCount = events.length;
      productCount = products.length;

      if (events.length === 0 && products.length === 0) {
        console.error(
          `[weekly-report] 推送[${channel}]: iso_week=${anchor.isoWeek} 名单为空 → skipped`,
        );
        channels.push({ channel, outcome: 'skipped', targetIds: [] });
        continue;
      }

      // 周报幂等粒度「一周一份」：dispatcher 的 target_id 取自 SelectedEvent.eventId，故把整份周报
      // 折成**单条** target_id=iso_week 的汇总条目交给 dispatcher（一份周报 = 一个 push_record）。
      // 正文（事件+产品列表）由周报渲染器（message.ts weekly 分支，复用各条已落库 headline/summary）
      // 展开；此处 SelectedEvent 仅承载 weekly 渲染所需的入选明细。
      const summaryItem = buildWeeklySummaryItem(anchor, events, products);

      const dispatch = await dispatchDigest(
        [summaryItem],
        {
          now: dispatchNow,
          sender,
          targetType: TARGET_TYPE.weekly,
          channel,
        },
        dbh,
      );
      console.error(
        `[weekly-report] 推送[${channel}]: outcome=${dispatch.outcome}, iso_week=${anchor.isoWeek}, ` +
          `事件 ${events.length} + 产品 ${products.length}`,
      );
      channels.push({
        channel,
        outcome: dispatch.outcome,
        targetIds: dispatch.eventIds,
      });
    } finally {
      await lock.release();
    }
  }

  return {
    pushDate: anchor.pushDate,
    isoWeek: anchor.isoWeek,
    eventCount,
    productCount,
    channels,
  };
}

/**
 * 把周报锚点 + 入选事件/产品折成交给 dispatcher 的**单条**汇总条目（target_id=iso_week）。
 *
 * dispatcher/message 渲染对 weekly target_type 走 message.ts 的 weekly 分支展开正文（事件+产品
 * 列表），故把入选明细挂在 weeklyItems 上（SelectedEvent 扩展可选字段，仅 weekly 用）；title 用
 * iso_week 标签，summary/headline 置 null（正文不取自单条摘要而由 weekly 渲染器展开列表）。
 */
function buildWeeklySummaryItem(
  anchor: WeeklyAnchor,
  events: readonly SelectedEvent[],
  products: readonly SelectedEvent[],
): WeeklySelectedEvent {
  return {
    eventId: anchor.isoWeek, // target_id = iso_week（一周一份）。
    representativeTitle: `AI Radar 周报 ${anchor.isoWeek}`,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
    // weekly 渲染明细（仅 weekly target_type 用；其他 target_type 无此字段、渲染走原逻辑）。
    weeklyItems: { events: [...events], products: [...products] },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 独立 BullMQ queue / worker 工厂（独立周级调度，绝不嵌 runDailyWorkflow / 复用日报队列）
// ──────────────────────────────────────────────────────────────────────────

/** weekly-report job 的 payload（预留 now 供手动触发指定时刻）。 */
export interface WeeklyReportJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定周；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/** 创建 weekly-report 队列实例（独立队列，调用方负责 close）。 */
export function createWeeklyReportQueue(
  connection: ConnectionOptions = buildConnection(),
): Queue<WeeklyReportJobData> {
  return new Queue<WeeklyReportJobData>(WEEKLY_REPORT_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: env.DAILY_DIGEST_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册周报周级 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 *
 * 默认 cron = DEFAULT_WEEKLY_CRON（每周一 09:07 Asia/Shanghai，避整点/半点降飞书限流）；
 * 可由参数覆盖（wiring 层注入）。cron 时区默认与 push_date 同源 Asia/Shanghai，防漂移。
 *
 * @param queue 周报队列。
 * @param pattern cron 表达式（默认 DEFAULT_WEEKLY_CRON）。
 * @param tz cron 时区（默认 DEFAULT_WEEKLY_CRON_TZ）。
 */
export async function scheduleWeeklyReport(
  queue: Queue<WeeklyReportJobData>,
  pattern: string = DEFAULT_WEEKLY_CRON,
  tz: string = DEFAULT_WEEKLY_CRON_TZ,
): Promise<Job<WeeklyReportJobData>> {
  return queue.upsertJobScheduler(
    WEEKLY_CRON_JOB_ID,
    { pattern, tz },
    {
      name: WEEKLY_REPORT_JOB,
      data: {},
    },
  );
}

export interface WeeklyReportWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 透传给 runWeeklyReport 的注入点（生产留空走默认；测试/手动可注入）。 */
  workflow?: Omit<RunWeeklyReportOptions, 'now'>;
  /** 并发度（周报由 per-channel 单例锁兜底，默认 1）。 */
  concurrency?: number;
}

/**
 * 创建并启动 weekly-report worker（独立 worker，调用方负责 worker.close()）。
 * job.data.nowIso 存在时用它作参考时刻（手动回填特定周）；否则用当前时刻（cron 触发）。
 */
export function createWeeklyReportWorker(
  options: WeeklyReportWorkerOptions = {},
): Worker<WeeklyReportJobData, RunWeeklyReportResult> {
  const connection = options.connection ?? buildConnection();

  return new Worker<WeeklyReportJobData, RunWeeklyReportResult>(
    WEEKLY_REPORT_QUEUE,
    async (job: Job<WeeklyReportJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      return runWeeklyReport({
        ...options.workflow,
        ...(now ? { now } : {}),
      });
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
    },
  );
}
