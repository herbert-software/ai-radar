/**
 * BullMQ 常驻运行时入口（daily-intel-pipeline / realtime-alerts / product-discovery /
 * weekly-report）—— `npm run worker` 执行本文件。
 *
 * 把已有导出接成一个常驻进程：为四条**独立并列**的调度链各注册 cron 重复任务 + 启动 worker。
 * 本文件只做 wiring（编排已实现的工厂），不含任何业务逻辑——业务全在各自的 run* 函数
 * （runDailyWorkflow / runAlertScan / runProductDigest / runWeeklyReport，纯顺序，由 worker await）。
 *
 * 四条调度链（互不嵌套、各自独立队列/worker/cron）：
 *   1. 日报      daily-digest    每日 DAILY_DIGEST_CRON
 *   2. 产品发现  product-digest  每日 DAILY_DIGEST_CRON（独立队列，复用日报 cron 时刻）
 *   3. 实时告警  alert-scan      每 ALERT_SCAN_CRON（默认 20min）
 *   4. 周报      weekly-report   每周 DEFAULT_WEEKLY_CRON（每周一 09:07）
 *
 * 用法：
 *   npm run worker   # 常驻：四条链按各自 cron 定时触发。Ctrl-C 退出。
 *
 * 前置：docker compose up -d（redis + postgres healthy）、npm run migrate、.env 填好凭据。
 * 想立刻验证一次不等到 cron 点，用 `npm run smoke`（直接触发一次 runDailyWorkflow）。
 *
 * 退出：收到 SIGINT/SIGTERM 时优雅关闭全部 worker、queue 与各自连接。
 */
import { Redis } from 'ioredis';
import type { Queue, Worker } from 'bullmq';
import {
  createDailyDigestQueue,
  scheduleDailyDigest,
  buildConnection,
} from './queue.js';
import { createDailyDigestWorker } from './worker.js';
import {
  createAlertScanQueue,
  scheduleAlertScan,
  createAlertScanWorker,
  buildAlertConnection,
} from './alert-queue.js';
import {
  createProductDigestQueue,
  scheduleProductDigest,
  createProductDigestWorker,
} from './product-digest.js';
import {
  createWeeklyReportQueue,
  scheduleWeeklyReport,
  createWeeklyReportWorker,
} from './weekly-report.js';
import { isWeeklyReportEnabled } from '../config/env.js';

/** 一条调度链的运行时句柄（worker + queue + 其复用的连接），供统一优雅关闭。 */
interface ScheduledLane {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  worker: Worker<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: Queue<any>;
  /** 该链 worker/queue 复用的底层 ioredis 连接（shutdown 时 quit）。 */
  connection: unknown;
}

async function main(): Promise<void> {
  const lanes: ScheduledLane[] = [];

  // ── 链 1：日报 daily-digest（worker 复用同一 connection，shutdown 时一次 quit 即可）。
  {
    const connection = buildConnection();
    const queue = createDailyDigestQueue(connection);
    await scheduleDailyDigest(queue);
    const worker = createDailyDigestWorker({ connection });
    lanes.push({ name: 'daily-digest', worker, queue, connection });
  }

  // ── 链 2：产品发现 product-digest（独立队列，复用日报 cron 时刻，独立单例锁兜底并发）。
  {
    const connection = buildConnection();
    const queue = createProductDigestQueue(connection);
    await scheduleProductDigest(queue);
    const worker = createProductDigestWorker({ connection });
    lanes.push({ name: 'product-digest', worker, queue, connection });
  }

  // ── 链 3：实时告警 alert-scan（高频轮询，独立连接 buildAlertConnection）。
  {
    const connection = buildAlertConnection();
    const queue = createAlertScanQueue(connection);
    await scheduleAlertScan(queue);
    const worker = createAlertScanWorker({ connection });
    lanes.push({ name: 'alert-scan', worker, queue, connection });
  }

  // ── 链 4：周报 weekly-report（周级 cron，独立单例锁按 iso_week 兜底并发）。
  //    默认禁用（WEEKLY_REPORT_ENABLED='false'，暂缓打磨）；实现与测试保留、改 env 即启用。
  if (isWeeklyReportEnabled()) {
    const connection = buildConnection();
    const queue = createWeeklyReportQueue(connection);
    await scheduleWeeklyReport(queue);
    const worker = createWeeklyReportWorker({ connection });
    lanes.push({ name: 'weekly-report', worker, queue, connection });
  }

  console.error(
    `[worker] 已启动 ${lanes.length} 条调度链（${lanes
      .map((l) => l.name)
      .join(', ')}），已注册各自 cron 重复任务，等待触发。Ctrl-C 退出。`,
  );

  for (const lane of lanes) {
    lane.worker.on('completed', (job, result) => {
      console.error(
        `[worker][${lane.name}] job ${job.id} 完成，outcome=${result?.outcome ?? '(无)'}`,
      );
    });
    lane.worker.on('failed', (job, err) => {
      console.error(`[worker][${lane.name}] job ${job?.id} 失败：`, err);
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 重复信号幂等，避免并发 close/quit。
    shuttingDown = true;
    console.error(`[worker] 收到 ${signal}，优雅关闭 ${lanes.length} 条调度链…`);
    // 先关全部 worker（停止消费），再关 queue，最后 quit 各自底层连接，避免句柄泄漏挂起退出。
    for (const lane of lanes) {
      try {
        await lane.worker.close();
        await lane.queue.close();
        await (lane.connection as Redis).quit();
      } catch (err) {
        console.error(`[worker][${lane.name}] 关闭时出错（继续关闭其余链）：`, err);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[worker] 启动失败：', err);
  process.exitCode = 1;
});
