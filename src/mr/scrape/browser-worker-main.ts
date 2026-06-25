/**
 * Model Radar（P5 / 5b，design D11/D15）browser 档**独立 entrypoint**（独立镜像装 Playwright + 浏览器）。
 *
 * **不**在 `worker-main.ts` 内 `new Worker`（否则 Playwright 进主镜像，违背「主镜像不装」，design D15）。
 * 用法：`tsx src/mr/scrape/browser-worker-main.ts`（独立 compose service，跑在封 RFC1918/link-local/
 * `169.254.169.254` 的 egress 代理或容器 netns 内——**必需部署控制**，design D11）。
 *
 * **启动 fail-closed 自检**（design D11，把 egress 从运维指令升为运行时门）：
 * 对每段一个代表哨兵（元数据 `169.254.169.254` + RFC1918 + 环回 `127.0.0.1`）做 TCP 建连，
 * **任一未被网络层 egress 挡住则非零退出、拒绝启动、不消费任何 job**（防偏配/未配 egress 裸奔成 SSRF-to-metadata 洞）。
 */
import { isMrScrapeEnabled } from '../../config/env.js';
import {
  createMrScrapeBrowserQueue,
  scheduleMrScrapeBrowser,
  createMrScrapeBrowserWorker,
  buildScrapeConnection,
} from './scrape-queue.js';
import { egressSelfTest } from './browser-tier.js';
import type { NetworkConnectFn } from './ssrf-guard.js';
import type { ConnectionOptions } from 'bullmq';

/**
 * 启动 browser worker（先 fail-closed 自检）。返回清理函数。
 * 自检不过 → 抛错（main 捕获后非零退出，不注册 worker）。
 */
export async function startBrowserWorker(opts: {
  connection?: ConnectionOptions;
  connect?: NetworkConnectFn | undefined;
  egressTimeoutMs?: number | undefined;
} = {}): Promise<() => Promise<void>> {
  // ① fail-closed 自检：egress 未挡住任一哨兵 → 拒启动。必须测网络层，不走 Playwright route。
  const egressOk = await egressSelfTest({
    connect: opts.connect,
    timeoutMs: opts.egressTimeoutMs,
  });
  if (!egressOk) {
    throw new Error(
      'mr-browser-worker: egress 自检失败——私网/元数据哨兵可达，拒绝启动（fail-closed，design D11）',
    );
  }

  // ② 自检过 → 注册队列/cron/worker。
  const connection = opts.connection ?? buildScrapeConnection();
  const queue = createMrScrapeBrowserQueue(connection);
  await scheduleMrScrapeBrowser(queue);
  const worker = createMrScrapeBrowserWorker({ connection });

  return async () => {
    await worker.close();
    await queue.close();
    await (connection as unknown as { quit?: () => Promise<unknown> }).quit?.();
  };
}

/** entrypoint：总开关关则不启动；自检不过则非零退出。 */
async function main(): Promise<void> {
  if (!isMrScrapeEnabled()) {
    console.log('[mr-browser-worker] MR_SCRAPE_ENABLED=false，不启动 browser 抓取链。');
    return;
  }
  let cleanup: (() => Promise<void>) | null = null;
  try {
    cleanup = await startBrowserWorker();
    console.log('[mr-browser-worker] egress 自检通过，browser 抓取链已启动。');
  } catch (err) {
    console.error(
      '[mr-browser-worker] 启动失败（fail-closed，不消费 job）：',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1; // 非零退出，拒绝启动。
    return;
  }

  const shutdown = async (): Promise<void> => {
    if (cleanup) await cleanup().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// 仅作为 entrypoint 直接运行时执行 main（被 import 测试时不自动启动）。
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  void main();
}
