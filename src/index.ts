/**
 * 应用启动入口（组 D，任务 4.1）—— `npm run dev` / `npm start` 执行本文件。
 *
 * import app（已在 src/config/env.ts 启动期校验 env），用 @hono/node-server 监听端口。
 * 端口取 PORT，默认 3000。
 *
 * 优雅关闭：收到 SIGINT/SIGTERM 时 close server（停止接收新连接、drain 在途请求）再退出，
 * 与 worker-main.ts 同口径。容器内由 compose 的 init:true（tini）把 docker stop 的 SIGTERM
 * 可靠转发到本进程。
 */
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { startSnapshotBackgroundRefresh } from './mr/snapshot/background.js';

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-radar 已启动，监听 http://localhost:${info.port}（健康检查：/health）`);
});

// Model Radar 快照后台刷新（5d）：subscriber 收跨进程失效 + 周期 rebuild 驱动 stale 翻转/漏消息自愈。
const snapshotBg = startSnapshotBackgroundRefresh();

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return; // 重复信号幂等。
  shuttingDown = true;
  // best-effort fire（不 await）：clearInterval 同步即时、quit 异步 best-effort，不阻塞下方 server.close/exit。
  void snapshotBg.stop();
  console.error(`[web] 收到 ${signal}，关闭 HTTP server…`);
  // close() 停止接收新连接、在途请求处理完后回调退出。但 http.Server.close() **不会**
  // 主动断开空闲 keep-alive 连接（监控/反代常驻探活会保活），否则回调永不触发 → 卡到
  // SIGKILL。故显式断空闲连接（Node 18.2+），并加超时兜底确保最终退出（8s < 容器 grace：web 15s）。
  server.close(() => process.exit(0));
  if ('closeIdleConnections' in server) {
    server.closeIdleConnections();
  }
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
