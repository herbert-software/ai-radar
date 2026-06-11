/**
 * BullMQ 每日定时触发器与队列定义（daily-intel-pipeline 10.2，design D7）。
 *
 * BullMQ 在本期**仅充当两件事**（绝不拆阶段队列）：
 * 1. 定时触发器：一个 cron 重复任务每天定点投递 `daily-digest` job；
 * 2. 整 job 重试外壳：job 失败（含被熔断中止）按 attempts 整条重试，
 *    而非把五个阶段拆成五个相互投递的队列（违背确定性工作流原则）。
 *
 * 实际业务全在 runDailyWorkflow（纯顺序），worker（./worker.ts）只是 await 调用它。
 *
 * 关键不变量：
 * - 单队列单 job 名，cron 由 env.DAILY_DIGEST_CRON（+ tz）配置；
 * - repeat job 用稳定 jobId（'daily-digest-cron'）防重复注册同一 cron；
 * - 连接复用 env.REDIS_URL（与锁/健康检查同一 Redis）。
 */
import { Queue, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** 队列名（单队列，design D7 不拆阶段队列）。 */
export const DAILY_DIGEST_QUEUE = 'daily-digest';
/** job 名。 */
export const DAILY_DIGEST_JOB = 'daily-digest';
/** cron 重复任务的稳定标识，防重复注册。 */
const CRON_JOB_ID = 'daily-digest-cron';

/** daily-digest job 的 payload（本期无需参数，预留 now 供手动触发指定时刻）。 */
export interface DailyDigestJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定日时用；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/**
 * BullMQ 连接（复用 env.REDIS_URL）。
 * maxRetriesPerRequest=null 是 BullMQ Worker 的硬性要求（阻塞命令不可有限重试）；
 * Queue 端一并用同样配置，连接语义一致。调用方负责 quit/close 该连接。
 */
export function buildConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

/** 创建 daily-digest 队列实例（调用方负责 close）。 */
export function createDailyDigestQueue(
  connection: ConnectionOptions = buildConnection(),
): Queue<DailyDigestJobData> {
  return new Queue<DailyDigestJobData>(DAILY_DIGEST_QUEUE, {
    connection,
    defaultJobOptions: {
      // 整 job 重试外壳：失败（含熔断中止）整条重试，不拆阶段（design D7）。
      attempts: env.DAILY_DIGEST_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 60_000 },
      // 完成/失败的 job 限量保留，避免 Redis 无限堆积。
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册每日 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 *
 * BullMQ 按 env.DAILY_DIGEST_CRON（默认每日 08:00）+ DAILY_DIGEST_CRON_TZ
 * （默认 Asia/Shanghai，与 push_date 同源防漂移）定点投递 daily-digest job。
 *
 * @returns 注册的重复任务模板 job 句柄。
 */
export async function scheduleDailyDigest(
  queue: Queue<DailyDigestJobData>,
): Promise<Job<DailyDigestJobData>> {
  return queue.upsertJobScheduler(
    CRON_JOB_ID,
    {
      pattern: env.DAILY_DIGEST_CRON,
      tz: env.DAILY_DIGEST_CRON_TZ,
    },
    {
      name: DAILY_DIGEST_JOB,
      data: {},
    },
  );
}
