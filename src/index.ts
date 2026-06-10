/**
 * 应用启动入口（组 D，任务 4.1）—— `npm run dev` 执行本文件。
 *
 * import app（已在 src/config/env.ts 启动期校验 env），用 @hono/node-server 监听端口。
 * 端口取 PORT，默认 3000。
 */
import { serve } from '@hono/node-server';
import { app } from './app.js';

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-radar 已启动，监听 http://localhost:${info.port}（健康检查：/health）`);
});
