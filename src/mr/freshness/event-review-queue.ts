/**
 * Model Radar（P5 / 5b）事件流触发复核的**独立** BullMQ 调度入口（task 4.1，design D8/D14）。
 *
 * 与日报 daily-digest / 实时告警 alert-queue **并列、独立**——**不嵌入 runDailyWorkflow**（cron 时点
 * 在每日 workflow 产出事件之后错峰，env.MR_EVENT_REVIEW_CRON 默认 `23 8 * * *`）。对齐 alert-queue 范式：
 * BullMQ 仅充当 ① 定时触发器（cron 投递 job）+ ② 整 job 重试外壳（attempts/backoff）。
 * 纯业务全在 runEventReview（见 ./event-consumer.ts），worker 只 await 它。
 *
 * 关键不变量（对齐 alert-queue）：
 * - 单队列单 job 名，cron 由 env.MR_EVENT_REVIEW_CRON（+ tz）配置；
 * - repeat job 用稳定 jobId 防重复注册同一 cron；
 * - 连接复用 env.REDIS_URL（与日报/告警/锁同一 Redis）；
 * - 重试耗尽**保留 failed job** 供人工排查/重放（removeOnFail 计数保留，design D14）。
 *
 * worker-main.ts 的 lane 装配由 G 统一负责；本文件**只产队列模块**（不在 worker-main 内 new Worker）。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import {
  runEventReview,
  type RunEventReviewOptions,
  type RunEventReviewResult,
} from './event-consumer.js';

/** 队列名（独立于 daily-digest / alert-scan，design D8 独立调度入口）。 */
export const MR_EVENT_REVIEW_QUEUE = 'mr-event-review';
/** job 名。 */
export const MR_EVENT_REVIEW_JOB = 'mr-event-review';
/** cron 重复任务的稳定标识，防重复注册。 */
const CRON_JOB_ID = 'mr-event-review-cron';

/** event-review job 的 payload（预留 nowIso 供手动触发指定时刻）。 */
export interface MrEventReviewJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定日时用；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/**
 * BullMQ 连接（复用 env.REDIS_URL）。maxRetriesPerRequest=null 是 BullMQ Worker 的硬性要求。
 * 调用方负责 quit/close 该连接。
 */
export function buildEventReviewConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

/** 创建 event-review 队列实例（调用方负责 close）。 */
export function createEventReviewQueue(
  connection: ConnectionOptions = buildEventReviewConnection(),
): Queue<MrEventReviewJobData> {
  return new Queue<MrEventReviewJobData>(MR_EVENT_REVIEW_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: env.MR_EVENT_REVIEW_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 100 },
      // 失败保留供人工排查/重放（design D14：重试耗尽不改事实、记录 failed）。
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 * BullMQ 按 env.MR_EVENT_REVIEW_CRON + _CRON_TZ 定点投递 job。
 */
export async function scheduleEventReview(
  queue: Queue<MrEventReviewJobData>,
): Promise<Job<MrEventReviewJobData>> {
  return queue.upsertJobScheduler(
    CRON_JOB_ID,
    {
      pattern: env.MR_EVENT_REVIEW_CRON,
      tz: env.MR_EVENT_REVIEW_CRON_TZ,
    },
    {
      name: MR_EVENT_REVIEW_JOB,
      data: {},
    },
  );
}

export interface EventReviewWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 透传给 runEventReview 的注入点（生产留空走默认；测试/手动可注入 db 桩 / windowDays）。 */
  review?: Omit<RunEventReviewOptions, 'now'>;
  /** 并发度（默认 1）。 */
  concurrency?: number;
}

/**
 * 创建并启动 event-review worker。调用方负责 worker.close()。
 * job.data.nowIso 存在时用它作参考时刻；否则用当前时刻（cron 触发）。
 */
export function createEventReviewWorker(
  options: EventReviewWorkerOptions = {},
): Worker<MrEventReviewJobData, RunEventReviewResult> {
  const connection = options.connection ?? buildEventReviewConnection();

  return new Worker<MrEventReviewJobData, RunEventReviewResult>(
    MR_EVENT_REVIEW_QUEUE,
    async (job: Job<MrEventReviewJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      return runEventReview({
        ...options.review,
        ...(now ? { now } : {}),
      });
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
    },
  );
}
