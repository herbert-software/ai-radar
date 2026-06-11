/**
 * BullMQ daily-digest worker（daily-intel-pipeline 10.2，design D7）。
 *
 * worker 是「整 job 重试外壳」的执行端：消费 daily-digest job → await runDailyWorkflow()。
 * **不拆阶段队列**——worker 内不投递任何子消息，全部业务在 runDailyWorkflow 顺序完成。
 *
 * 失败语义（整 job 重试外壳）：
 * - runDailyWorkflow 抛错（含 WorkflowAbortError 熔断中止、或某阶段未捕获异常）→ job 失败 →
 *   BullMQ 按 queue 的 attempts/backoff 整条重试。熔断中止特意**抛出**而非吞掉，使
 *   「key 失效/限流」等系统级故障在退避后重试时可能恢复，且失败在 BullMQ 可观测。
 * - 单例锁未抢到（outcome='skipped-locked'）不算失败：另一实例在跑，本 job 正常完成。
 */
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  DAILY_DIGEST_QUEUE,
  buildConnection,
  type DailyDigestJobData,
} from './queue.js';
import {
  runDailyWorkflow,
  type RunDailyWorkflowOptions,
  type RunDailyWorkflowResult,
} from './run-daily-workflow.js';

export interface DailyDigestWorkerOptions {
  /** BullMQ 连接（默认复用 env.REDIS_URL）。 */
  connection?: ConnectionOptions;
  /** 透传给 runDailyWorkflow 的注入点（生产留空走默认；测试/手动可注入）。 */
  workflow?: Omit<RunDailyWorkflowOptions, 'now'>;
  /** 并发度（日报是单例任务，默认 1；多于 1 也由单例锁兜底）。 */
  concurrency?: number;
}

/**
 * 创建并启动 daily-digest worker。调用方负责 worker.close()。
 *
 * job.data.nowIso 存在时用它作参考时刻（手动回填特定日）；否则用当前时刻（cron 触发）。
 */
export function createDailyDigestWorker(
  options: DailyDigestWorkerOptions = {},
): Worker<DailyDigestJobData, RunDailyWorkflowResult> {
  const connection = options.connection ?? buildConnection();

  return new Worker<DailyDigestJobData, RunDailyWorkflowResult>(
    DAILY_DIGEST_QUEUE,
    async (job: Job<DailyDigestJobData>) => {
      const now = job.data?.nowIso ? new Date(job.data.nowIso) : undefined;
      // 纯顺序工作流：worker 只 await 它，不拆阶段、不投递子消息（design D7）。
      return runDailyWorkflow({
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
