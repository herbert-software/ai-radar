/**
 * 每日产品发现推送（任务 8.1 / 8.2，product-discovery「每日产品发现推送」）。
 *
 * **独立调度任务（对齐 daily-intel-pipeline，绝不塞进 runDailyWorkflow 的日报顺序链）**：
 * 产品发现是与日报并列的独立 BullMQ 调度任务，其**内部**是一条顺序子流程
 *   采集 PH → 产品塌缩 → 选名单 → 推送
 * 但整体独立于日报链运行（见本文件 queue/worker 工厂）。
 *
 * 关键不变量（绝不可违背，spec product-discovery）：
 * - 幂等四元组 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`
 *   （push_date 取 Asia/Shanghai，与事件日报 push_date **时区口径同源**——复用 push-date.ts 的
 *   getPushDate，二者用同一时区计算「今天」，否则跨零点把一天算两天致跨天候选窗口失效）。
 *   与事件日报（`target_type='event'`）各自独立命名空间，互不挤占。
 * - **跨天不重推候选窗口**：候选必须满足「该 product_id 从未被任何 push_date 以该 channel
 *   `success` 推送过」——否则产品因 PH 持续上榜、last_seen 天天刷新会每天以新 push_date 重新
 *   入选、UNIQUE 四元组每天不冲突 → 天天重推同一产品。「同日不重复」由 UNIQUE 兜底，「跨天
 *   一产品一生只推一次」由本候选窗口兜底，两层叠加不可删其一。
 * - **排除 merge_conflict**：被标记 merge_conflict 的产品（同一真实产品散为多个 product_id）
 *   其多行各自满足「从未 success」会被各推一次，违反「一产品一生一次」；故排除出候选，直到
 *   P3 跨行合并解决（宁可暂不推，也不重复推）。
 * - **候选查询必须在产品塌缩之后执行**：确保 merge_conflict 标记对候选可见，否则推送先于塌缩
 *   会漏掉刚产生的冲突标记把冲突产品各推一次（本文件顺序子流程：采集→塌缩→选名单→推送）。
 * - **复用 dispatcher 同一套状态机核心**（待发→pending→原子送达→success/failed），仅 target_type
 *   与候选/幂等口径不同，**禁止另写一套漂移的状态机**；唯一键冲突即跳过。
 * - **独立单例锁** `product-digest:{channel}:{push_date}`（job 级短时持有 + TTL/finally 释放），
 *   防两并发实例各读待发集合各发一条（UNIQUE 挡不住此并发）。与日报锁 `daily-digest:{push_date}`
 *   不同命名空间，互不挤占。
 * - 推送名单**由程序规则决定，禁止由 LLM 决定最终推送名单**。
 *
 * 文件归属边界：本文件只调用/引用 dispatcher / targets / collectors / product-collapse 已导出
 * 函数，不重写其逻辑、不改 schema；产品候选查询在本文件用程序条件表达。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiProducts, pushRecords } from '../db/schema.js';
import { env, isFeishuEnabled } from '../config/env.js';
import {
  collectProductHunt,
  type ProductHuntCollectorOptions,
} from '../collectors/product-hunt.js';
import { storeCollectedItems } from '../collectors/store.js';
import { collapseUncollapsedProductRawItems } from '../collectors/product-collapse.js';
import {
  dispatchDigest,
  type DispatchResult,
  type MessageSender,
} from '../push/dispatcher.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { createTelegramSender } from '../push/telegram.js';
import { createFeishuSender } from '../push/feishu.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';
import { getPushDate } from '../push/push-date.js';
import { buildConnection } from './queue.js';

type DbLike = typeof defaultDb;

/**
 * 产品推送单例锁默认 TTL（毫秒）：10 分钟。覆盖单 channel 一次产品 dispatch 的最坏时长
 * （拼一条消息 + 一次外部发送 + 状态机写库）。比日报锁短——产品推送是 job 级短时持有、
 * 不含逐条 LLM 调用。崩溃时该 TTL 是「同 channel 同日重新获取锁」的恢复上界。
 */
const DEFAULT_PRODUCT_LOCK_TTL_MS = 10 * 60 * 1000;

/** 产品发现推送队列名（独立于 daily-digest，绝不复用日报队列）。 */
export const PRODUCT_DIGEST_QUEUE = 'product-digest';
/** 产品发现推送 job 名。 */
export const PRODUCT_DIGEST_JOB = 'product-digest';
/** cron 重复任务稳定标识，防重复注册同一 cron。 */
const PRODUCT_CRON_JOB_ID = 'product-digest-cron';

// ──────────────────────────────────────────────────────────────────────────
// 候选查询：程序规则选当日推送产品（非 LLM 定名单）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 选当日某 channel 的产品推送候选（程序规则，**非 LLM**）。
 *
 * 候选条件（全在 SQL 层用程序条件表达）：
 * - **排除 merge_conflict**：`metadata->'merge_conflict' IS NULL`（被标记冲突的多行各自满足
 *   「从未 success」会被各推一次，违反「一产品一生一次」，排除直到 P3 跨行合并解决）。
 * - **跨天不重推候选窗口**：`NOT EXISTS(push_records success for this product_id on the target
 *   channel on any push_date)`——「从未以该 channel success」而非「今天未 success」（跨天/跨次
 *   不重推；按目标 channel 分别判定，同一产品可分别进入 telegram 与 feishu 候选）。
 *
 * 「同日不重复」由 dispatcher 的待发集合「今日该 channel success 排除」+ UNIQUE 四元组兜底，
 * 本查询只管「跨天从未 success」与「排除冲突」。名单由程序定、不交 LLM。
 *
 * @param channel 目标分发通道（候选「从未以该 channel success」按 channel 分别判定）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 * @param limit   取前 N 条（默认 env.TOP_N，与日报同口径）；按 last_seen_at DESC 优先近期上榜。
 */
export async function selectProductCandidates(
  channel: Channel,
  dbh: DbLike = defaultDb,
  limit: number = env.TOP_N,
): Promise<SelectedEvent[]> {
  // 「从未以该 channel success」相关子查询（跨天/跨次不重推）；target_type='product'、
  // target_id=product_id（product_id 与 push_records.target_id 同为 VARCHAR(128)，类型相容）。
  const neverSuccessfullyPushed = notExists(
    dbh
      .select({ one: sql`1` })
      .from(pushRecords)
      .where(
        and(
          eq(pushRecords.targetType, TARGET_TYPE.product),
          eq(pushRecords.targetId, aiProducts.productId),
          eq(pushRecords.channel, channel),
          eq(pushRecords.status, 'success'),
        ),
      ),
  );

  const rows = await dbh
    .select({
      productId: aiProducts.productId,
      name: aiProducts.name,
      lastSeenAt: aiProducts.lastSeenAt,
    })
    .from(aiProducts)
    .where(
      and(
        // 排除 merge_conflict：metadata->'merge_conflict' 不存在（NULL）即未冲突。
        // product-collapse 用 `metadata || {merge_conflict:{...}}` 标记，故以 JSON 路径判存在。
        isNull(sql`${aiProducts.metadata} -> 'merge_conflict'`),
        neverSuccessfullyPushed,
      ),
    )
    // 近期上榜优先（确定性 tiebreaker：product_id ASC），取前 limit 条。
    .orderBy(sql`${aiProducts.lastSeenAt} DESC NULLS LAST`, aiProducts.productId)
    .limit(limit);

  // 映射为 dispatcher 输入视图（SelectedEvent 复用，eventId=product_id、标题=产品名）。
  // dispatcher/message 渲染只用 eventId/标题/摘要/链接——产品无 headline/summary，置 null
  // 走渲染回退（仅标题）。target_id=product_id 在 dispatcher 内由 e.eventId 承载。
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
// 独立单例锁：product-digest:{channel}:{push_date}
// ──────────────────────────────────────────────────────────────────────────

/** 最小 Redis 能力面（便于集成测注入内存桩；真实用 ioredis）。与 lock.ts 同形。 */
export interface ProductLockRedis {
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

/** 已持有的产品推送锁句柄；释放时核对令牌防误删他人锁。 */
export interface ProductDigestLock {
  readonly key: string;
  /** 释放锁（核对令牌后删除）。重复调用安全。 */
  release(): Promise<void>;
}

export interface AcquireProductLockOptions {
  /** 注入 Redis（默认按 env.REDIS_URL 新建一次性短连接）。 */
  redis?: ProductLockRedis;
  /** 锁 TTL（毫秒），默认 10 分钟。须覆盖单 channel 一次产品 dispatch 最坏时长。 */
  ttlMs?: number;
}

// 「核对令牌再删」——只删自己持有的锁，避免锁过期被他人重获后误删。
const PRODUCT_RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/** 产品推送锁键：`product-digest:{channel}:{push_date}`（独立命名空间，与日报锁不挤占）。 */
export function productLockKey(channel: Channel, pushDate: string): string {
  return `product-digest:${channel}:${pushDate}`;
}

/**
 * 尝试获取某 (channel, push_date) 的产品推送单例锁。
 *
 * 成功 → 返回 ProductDigestLock（带 finally release）；已被他人持有 → 返回 null（调用方放弃）。
 * 必须带 TTL（崩溃兜底）+ finally release（正常路径）。job 级短时持有，无需看门狗续租
 * （产品推送不含逐条 LLM 长任务，TTL 足够覆盖）。
 */
export async function acquireProductDigestLock(
  channel: Channel,
  pushDate: string,
  options: AcquireProductLockOptions = {},
): Promise<ProductDigestLock | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_PRODUCT_LOCK_TTL_MS;
  const key = productLockKey(channel, pushDate);
  const token = randomUUID();

  const ownsConnection = !options.redis;
  const redis: ProductLockRedis =
    options.redis ??
    (new Redis(env.REDIS_URL, { commandTimeout: 5000 }) as unknown as ProductLockRedis);

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
        await redis.eval(PRODUCT_RELEASE_SCRIPT, 1, key, token);
      } finally {
        if (ownsConnection) (redis as unknown as Redis).disconnect();
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 产品发现推送 workflow（顺序子流程：采集 PH → 塌缩 → 选名单 → 推送）
// ──────────────────────────────────────────────────────────────────────────

/** 单通道分发结果（供汇总/可观测/测试断言）。 */
export interface ProductChannelOutcome {
  channel: Channel;
  /** 'sent'/'failed'/'skipped' 同 dispatcher；'locked' = 未抢到该 channel 单例锁本实例放弃。 */
  outcome: DispatchResult['outcome'] | 'locked';
  /** 本次实际发出的 product_id 列表（locked/skipped 为空）。 */
  productIds: string[];
}

export interface RunProductDigestOptions {
  /** 参考时刻，决定 push_date（默认当前时刻）。 */
  now?: Date;
  /** 注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike;
  /** Product Hunt 采集选项（注入 mock fetchGraphql / token 等；测试可不触网）。 */
  collect?: ProductHuntCollectorOptions;
  /**
   * 跳过采集 + 塌缩，直接选名单 + 推送（测试用：库内已有 ai_products 时只验推送候选/幂等）。
   * 生产恒走完整子流程。
   */
  skipCollectAndCollapse?: boolean;
  /**
   * 各通道发送器显式注入（多通道分发）。未提供某已配置通道的 sender 时按 env 构造真实 sender。
   */
  senders?: Partial<Record<Channel, MessageSender>>;
  /**
   * 覆盖「已配置通道集」（测试用，无需真实 FEISHU env）。默认按 env 计算：恒含 telegram；
   * isFeishuEnabled() 为真时加 feishu。
   */
  channels?: readonly Channel[];
  /** 产品推送单例锁选项（注入 mock Redis / TTL）。 */
  lock?: AcquireProductLockOptions;
  /** 候选取前 N 条（默认 env.TOP_N）。 */
  limit?: number;
}

export interface RunProductDigestResult {
  pushDate: string;
  /** 本轮采集返回的 PH 产品条数（skipCollectAndCollapse 时为 0）。 */
  collectedCount: number;
  /** 本轮塌缩的 product raw_items 条数（skipCollectAndCollapse 时为 0）。 */
  collapsedCount: number;
  /** 各通道分发结果。 */
  channels: ProductChannelOutcome[];
}

/**
 * 解析「已配置通道集 + 各通道 sender」（与 run-daily-workflow 同口径）。
 * 通道集：默认恒含 telegram；isFeishuEnabled() 为真加 feishu；可由 options.channels 覆盖。
 * sender：优先 options.senders[channel]；否则按 env 构造真实 sender。
 */
function resolveChannelSenders(
  options: RunProductDigestOptions,
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
 * 跑一次完整产品发现推送（顺序子流程：采集 PH → 塌缩 → 选名单 → 推送）。
 *
 * 顺序不可乱（spec）：候选查询必须在塌缩之后，确保 merge_conflict 标记对候选可见。
 * 每个 channel 各自独立单例锁 `product-digest:{channel}:{push_date}`（job 级 + finally 释放），
 * 锁内：选该 channel 候选 → dispatch（复用同一状态机）。某 channel 未抢到锁则 outcome='locked'
 * 本实例放弃该通道（不拖垮其余通道）。
 *
 * @param options 注入点（now / db / 采集 mock / sender / 通道集 / 锁 / limit）。
 */
export async function runProductDigest(
  options: RunProductDigestOptions = {},
): Promise<RunProductDigestResult> {
  const now = options.now ?? new Date();
  const dbh = options.dbh ?? defaultDb;
  const pushDate = getPushDate(now);

  let collectedCount = 0;
  let collapsedCount = 0;

  // ── 顺序子流程阶段 1+2：采集 PH → 落 raw_items → 产品塌缩进 ai_products。
  //    候选查询必须在塌缩之后（merge_conflict 标记对候选可见，spec）。
  if (!options.skipCollectAndCollapse) {
    const collected = await collectProductHunt(options.collect ?? {});
    collectedCount = collected.length;
    if (collected.length > 0) {
      await storeCollectedItems(collected, { dbh });
    }
    const collapseOutcomes = await collapseUncollapsedProductRawItems(dbh);
    collapsedCount = collapseOutcomes.length;
    console.error(
      `[product-digest] 采集 ${collectedCount} 条 → 塌缩 ${collapsedCount} 条 product raw_items`,
    );
  }

  // ── 阶段 3+4：每个 channel 独立单例锁内「选名单 → 推送」（复用 dispatcher 同一状态机）。
  const channelSenders = resolveChannelSenders(options);
  const channels: ProductChannelOutcome[] = [];

  for (const { channel, sender } of channelSenders) {
    // 独立单例锁 product-digest:{channel}:{push_date}（防两并发实例各读待发各发一条）。
    const lock = await acquireProductDigestLock(channel, pushDate, options.lock);
    if (lock === null) {
      console.error(
        `[product-digest] 锁: ${channel} push_date=${pushDate} 未抢到单例锁，本实例放弃该通道`,
      );
      channels.push({ channel, outcome: 'locked', productIds: [] });
      continue;
    }

    try {
      // 选名单在锁内、塌缩之后执行（merge_conflict 可见 + 候选窗口跨天不重推）。
      const candidates = await selectProductCandidates(
        channel,
        dbh,
        options.limit ?? env.TOP_N,
      );
      if (candidates.length === 0) {
        console.error(`[product-digest] 推送[${channel}]: 候选 0 条 → skipped`);
        channels.push({ channel, outcome: 'skipped', productIds: [] });
        continue;
      }

      // 复用 dispatcher 同一套状态机核心（target_type='product'、channel、push_date 由其据 now 算）。
      const dispatch = await dispatchDigest(
        candidates,
        { now, sender, targetType: TARGET_TYPE.product, channel },
        dbh,
      );
      console.error(
        `[product-digest] 推送[${channel}]: outcome=${dispatch.outcome}, 发出 ${dispatch.eventIds.length} 条`,
      );
      channels.push({
        channel,
        outcome: dispatch.outcome,
        productIds: dispatch.eventIds,
      });
    } finally {
      await lock.release();
    }
  }

  return { pushDate, collectedCount, collapsedCount, channels };
}

// ──────────────────────────────────────────────────────────────────────────
// 独立 BullMQ queue / worker 工厂（独立调度，绝不嵌 runDailyWorkflow / daily-digest 队列）
// ──────────────────────────────────────────────────────────────────────────

/** product-digest job 的 payload（预留 now 供手动触发指定时刻）。 */
export interface ProductDigestJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定日；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/** 创建 product-digest 队列实例（独立队列，调用方负责 close）。 */
export function createProductDigestQueue(
  connection: ConnectionOptions = buildConnection(),
): Queue<ProductDigestJobData> {
  return new Queue<ProductDigestJobData>(PRODUCT_DIGEST_QUEUE, {
    connection,
    defaultJobOptions: {
      // 整 job 重试外壳：失败整条重试（含某通道 dispatch failed 抛错时；本期 runProductDigest
      // 隔离单通道失败不抛错，故重试主要兜采集/塌缩/DB 异常）。
      attempts: env.DAILY_DIGEST_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册产品发现 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 * 复用 env.DAILY_DIGEST_CRON / DAILY_DIGEST_CRON_TZ（与 push_date 同源 Asia/Shanghai）；
 * 产品发现是独立队列、独立 job，与日报并列调度。
 */
export async function scheduleProductDigest(
  queue: Queue<ProductDigestJobData>,
): Promise<Job<ProductDigestJobData>> {
  return queue.upsertJobScheduler(
    PRODUCT_CRON_JOB_ID,
    {
      pattern: env.DAILY_DIGEST_CRON,
      tz: env.DAILY_DIGEST_CRON_TZ,
    },
    {
      name: PRODUCT_DIGEST_JOB,
      data: {},
    },
  );
}

export interface ProductDigestWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 透传给 runProductDigest 的注入点（生产留空走默认；测试/手动可注入）。 */
  workflow?: Omit<RunProductDigestOptions, 'now'>;
  /** 并发度（产品推送由 per-channel 单例锁兜底，默认 1）。 */
  concurrency?: number;
}

/**
 * 创建并启动 product-digest worker（独立 worker，调用方负责 worker.close()）。
 * job.data.nowIso 存在时用它作参考时刻（手动回填特定日）；否则用当前时刻（cron 触发）。
 */
export function createProductDigestWorker(
  options: ProductDigestWorkerOptions = {},
): Worker<ProductDigestJobData, RunProductDigestResult> {
  const connection = options.connection ?? buildConnection();

  return new Worker<ProductDigestJobData, RunProductDigestResult>(
    PRODUCT_DIGEST_QUEUE,
    async (job: Job<ProductDigestJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      return runProductDigest({
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
