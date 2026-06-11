/**
 * 流水线编排对外入口（daily-intel-pipeline G7）。
 *
 * 汇出 runDailyWorkflow（纯顺序工作流）、BullMQ 队列/触发器/worker（触发器 + 整 job 重试外壳）
 * 与熔断判定纯函数。BullMQ 不拆阶段队列（design D7），熔断按阶段独立计算（design D8）。
 */
export {
  runDailyWorkflow,
  WorkflowAbortError,
  type RunDailyWorkflowOptions,
  type RunDailyWorkflowResult,
  type WorkflowOutcome,
  type AlertSink,
} from './run-daily-workflow.js';

export {
  createDailyDigestQueue,
  scheduleDailyDigest,
  buildConnection,
  DAILY_DIGEST_QUEUE,
  DAILY_DIGEST_JOB,
  type DailyDigestJobData,
} from './queue.js';

export {
  createDailyDigestWorker,
  type DailyDigestWorkerOptions,
} from './worker.js';

export {
  stageShouldAbort,
  stageDegradeRate,
  classifySystemFailure,
  type StageDegrade,
  type CollectStats,
  type SystemFailureVerdict,
} from './circuit-breaker.js';
