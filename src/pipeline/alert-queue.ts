/**
 * 实时告警高频扫描的**独立** BullMQ 调度入口（realtime-alerts / design D6）。
 *
 * 与日报 daily-digest（queue.ts/worker.ts）**并列、独立**——**不嵌入 runDailyWorkflow**，也不与
 * 日报阶段相互投递构成复杂队列图。BullMQ 在此仅充当两件事（不拆阶段队列）：
 * 1. 高频定时触发器：一个 cron 重复任务按 env.ALERT_SCAN_CRON（默认每 20min）投递 alert-scan job；
 * 2. 整 job 重试外壳：job 失败按 attempts 整条重试。
 *
 * 实际业务全在 runAlertScan（纯顺序，见 ./alert-scan.ts），worker 只 await 调用它。
 *
 * 关键不变量：
 * - 单队列单 job 名，cron 由 env.ALERT_SCAN_CRON（+ tz）配置；
 * - repeat job 用稳定 jobId（'alert-scan-cron'）防重复注册同一 cron；
 * - 连接复用 env.REDIS_URL（与日报/锁同一 Redis）。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import {
  runAlertScan,
  type RunAlertScanOptions,
  type RunAlertScanResult,
} from './alert-scan.js';

/** 队列名（独立于 daily-digest，design D6 独立调度入口）。 */
export const ALERT_SCAN_QUEUE = 'alert-scan';
/** job 名。 */
export const ALERT_SCAN_JOB = 'alert-scan';
/** cron 重复任务的稳定标识，防重复注册。 */
const CRON_JOB_ID = 'alert-scan-cron';

/** alert-scan job 的 payload（预留 now 供手动触发指定时刻）。 */
export interface AlertScanJobData {
  /** 可选参考时刻 ISO 串（手动触发回填特定日时用；cron 触发不带，worker 用当前时刻）。 */
  nowIso?: string;
}

/**
 * BullMQ 连接（复用 env.REDIS_URL）。maxRetriesPerRequest=null 是 BullMQ Worker 的硬性要求。
 * 调用方负责 quit/close 该连接。
 */
export function buildAlertConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

/** 创建 alert-scan 队列实例（调用方负责 close）。 */
export function createAlertScanQueue(
  connection: ConnectionOptions = buildAlertConnection(),
): Queue<AlertScanJobData> {
  return new Queue<AlertScanJobData>(ALERT_SCAN_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: env.ALERT_SCAN_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });
}

/**
 * 注册高频 cron 重复任务（幂等：稳定 jobId 防重复注册同一 cron）。
 *
 * BullMQ 按 env.ALERT_SCAN_CRON（默认每 20min）+ ALERT_SCAN_CRON_TZ（默认 Asia/Shanghai，
 * 与 push_date 同源防漂移）定点投递 alert-scan job。
 */
export async function scheduleAlertScan(
  queue: Queue<AlertScanJobData>,
): Promise<Job<AlertScanJobData>> {
  return queue.upsertJobScheduler(
    CRON_JOB_ID,
    {
      pattern: env.ALERT_SCAN_CRON,
      tz: env.ALERT_SCAN_CRON_TZ,
    },
    {
      name: ALERT_SCAN_JOB,
      data: {},
    },
  );
}

export interface AlertScanWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 透传给 runAlertScan 的注入点（生产留空走默认；测试/手动可注入）。 */
  workflow?: Omit<RunAlertScanOptions, 'now'>;
  /** 并发度（默认 1）。 */
  concurrency?: number;
}

/**
 * 创建并启动 alert-scan worker。调用方负责 worker.close()。
 *
 * job.data.nowIso 存在时用它作参考时刻；否则用当前时刻（cron 触发）。
 */
export function createAlertScanWorker(
  options: AlertScanWorkerOptions = {},
): Worker<AlertScanJobData, RunAlertScanResult> {
  const connection = options.connection ?? buildAlertConnection();

  return new Worker<AlertScanJobData, RunAlertScanResult>(
    ALERT_SCAN_QUEUE,
    async (job: Job<AlertScanJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      return runAlertScan({
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
