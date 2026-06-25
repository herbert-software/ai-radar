/**
 * 陈旧度排程的**独立** BullMQ 调度入口（design D9/D14，仿 `src/pipeline/alert-queue.ts` 四件套）。
 *
 * 与日报/告警**并列、独立**——**不嵌入 runDailyWorkflow / worker-main**（staleness lane 由 G 装配）。
 * BullMQ 在此仅充当：① 定时触发器（一个 cron 重复任务按 env.MR_STALENESS_CRON 投递 job）；
 * ② 整 job 重试外壳（失败按 attempts 整条重试，耗尽保留 failed 供人工排查，**失败不改事实**）。
 *
 * 业务全在 runStaleness（纯顺序，见 ./staleness.ts），worker 只 await 调用它。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { runStaleness, type RunStalenessResult } from './staleness.js';

/** 队列名（独立于日报/告警，design D14）。 */
export const MR_STALENESS_QUEUE = 'mr-staleness';
/** job 名。 */
export const MR_STALENESS_JOB = 'mr-staleness';
/** cron 重复任务的稳定标识，防重复注册同一 cron。 */
const CRON_JOB_ID = 'mr-staleness-cron';

/** staleness job 的 payload（预留 nowIso 供手动触发指定时刻）。 */
export interface MrStalenessJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定日时；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/**
 * BullMQ 连接（复用 env.REDIS_URL）。maxRetriesPerRequest=null 是 BullMQ Worker 的硬性要求。
 * 调用方负责 quit/close 该连接。
 */
export function buildStalenessConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

/** 创建 staleness 队列实例（调用方负责 close）。 */
export function createStalenessQueue(
  connection: ConnectionOptions = buildStalenessConnection(),
): Queue<MrStalenessJobData> {
  return new Queue<MrStalenessJobData>(MR_STALENESS_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: env.MR_STALENESS_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 30_000 },
      // 重试耗尽保留 failed job 供人工排查/重放（design D14）。
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册陈旧度 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 * 按 env.MR_STALENESS_CRON + MR_STALENESS_CRON_TZ 定点投递 job。
 */
export async function scheduleStaleness(
  queue: Queue<MrStalenessJobData>,
): Promise<Job<MrStalenessJobData>> {
  return queue.upsertJobScheduler(
    CRON_JOB_ID,
    {
      pattern: env.MR_STALENESS_CRON,
      tz: env.MR_STALENESS_CRON_TZ,
    },
    {
      name: MR_STALENESS_JOB,
      data: {},
    },
  );
}

export interface StalenessWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 并发度（默认 1）。 */
  concurrency?: number;
}

/**
 * 创建并启动 staleness worker。调用方负责 worker.close()。
 * job.data.nowIso 存在时用它作参考时刻；否则用当前时刻（cron 触发）。
 */
export function createStalenessWorker(
  options: StalenessWorkerOptions = {},
): Worker<MrStalenessJobData, RunStalenessResult> {
  const connection = options.connection ?? buildStalenessConnection();

  return new Worker<MrStalenessJobData, RunStalenessResult>(
    MR_STALENESS_QUEUE,
    async (job: Job<MrStalenessJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      return runStaleness(
        undefined,
        now ? { now } : {},
        env.MR_STALENESS_THRESHOLD_DAYS,
      );
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
    },
  );
}
