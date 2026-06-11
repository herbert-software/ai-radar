/**
 * BullMQ daily-digest 运行时入口（daily-intel-pipeline 收尾 11.3）—— `npm run worker` 执行本文件。
 *
 * 把已有导出接成一个常驻进程：注册每日 cron 重复任务（scheduleDailyDigest）+ 启动 worker
 * （createDailyDigestWorker）。本文件只做 wiring（编排已实现的工厂），不含任何业务逻辑——
 * 业务全在 runDailyWorkflow（纯顺序，由 worker await 调用，design D7）。
 *
 * 用法：
 *   npm run worker   # 常驻：按 DAILY_DIGEST_CRON（默认每日 08:00 Asia/Shanghai）定时触发日报
 *
 * 前置：docker compose up -d（redis + postgres healthy）、npm run migrate、.env 填好凭据。
 * 想立刻验证一次不等到 cron 点，用 `npm run smoke`（直接触发一次 runDailyWorkflow）。
 *
 * 退出：收到 SIGINT/SIGTERM 时优雅关闭 worker、queue 与连接。
 */
import { Redis } from 'ioredis';
import {
  createDailyDigestQueue,
  scheduleDailyDigest,
  buildConnection,
} from './queue.js';
import { createDailyDigestWorker } from './worker.js';

async function main(): Promise<void> {
  const connection = buildConnection();
  const queue = createDailyDigestQueue(connection);
  await scheduleDailyDigest(queue);
  // worker 复用同一 connection，shutdown 时一次 quit 即可彻底关闭底层 ioredis 连接。
  const worker = createDailyDigestWorker({ connection });

  console.error(
    '[worker] daily-digest worker 已启动，已注册每日 cron 重复任务，等待触发。Ctrl-C 退出。',
  );

  worker.on('completed', (job, result) => {
    console.error(`[worker] job ${job.id} 完成，outcome=${result?.outcome}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} 失败：`, err);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[worker] 收到 ${signal}，优雅关闭…`);
    await worker.close();
    await queue.close();
    // 显式关闭底层 ioredis 连接（worker 复用同一 connection），避免句柄泄漏挂起进程退出。
    await (connection as unknown as Redis).quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[worker] 启动失败：', err);
  process.exitCode = 1;
});
