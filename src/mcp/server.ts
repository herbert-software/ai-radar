/**
 * MCP 查询 server 入口（design D1/D7/D8，task 2.2）。
 *
 * 与流水线**并列的独立查询进程**（stdio transport）：暴露 8 工具（5 查询含 recommend_coding_subscription + 2 标记 + push_event_now），
 * **绝不参与主流程调度**——不 import/注册任何 cron/BullMQ/worker/runDailyWorkflow。
 *
 * **N2 / D8（堵传递 import 崩纯查询）**：本文件 top-level **只** static import MCP 自带的宽松 env、
 * 自建 db、tool 聚合（其传递依赖仅 schema.ts〔零 env〕+ targets.ts〔零 env〕+ zod + SDK）；
 * **绝不** static import `dispatcher`/`push-date`/`top-n`(value)/`telegram`/`feishu`/`db/index.ts`/
 * `config/env.ts`（它们 top-level import 全局 env、import 期即跑 parseEnv 崩纯查询）。
 * push_event_now 的推送链在其 handler 内**动态 import**（见 tools/push-event-now.ts）。
 * → **纯查询只需 DATABASE_URL**。
 *
 * **D7 stdio 纪律**：stdout 是 JSON-RPC 专用通道——所有日志/诊断/横幅一律 `console.error`/stderr，
 * **禁向 stdout 写任何非 JSON-RPC 内容**。
 *
 * **启动 fail-fast**：DATABASE_URL 缺失/畸形 → `process.stderr.write` 报错（含变量名 + 配置提示）+
 * `process.exit(1)`，**在 connect(transport) 之前、绝不经 stdout**。
 *
 * **优雅关闭**：SIGINT/SIGTERM + stdin/transport close 任一汇聚到 shutdown()，幂等（只 pool.end() 一次）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseMcpEnv } from './env.js';
import { getMcpDb, closeMcpDb } from './db.js';
import { setContext } from './context.js';
import { allTools } from './tools/index.js';

/** stderr 日志（绝不污染 stdout 的 JSON-RPC 通道）。 */
function logErr(message: string): void {
  console.error(`[mcp] ${message}`);
}

/** shutdown 幂等闸：多触发源（信号/stdin close/transport close）只真正关闭一次。 */
let shuttingDown = false;

/**
 * 优雅关闭：释放 MCP 自建 db 池（幂等）。
 * 关闭日志走 stderr；关闭后 exit(0)（正常退出）。
 */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logErr(`关闭中（${reason}）…`);
  try {
    await closeMcpDb();
  } catch (e) {
    logErr(`关闭 db 池失败：${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  // 1. MCP 宽松 env 解析（只硬 require DATABASE_URL）；缺失/畸形 → stderr + exit(1)（connect 之前）。
  const parsed = parseMcpEnv();
  if (!parsed.ok) {
    process.stderr.write(
      `[mcp] 启动失败：${parsed.message}\n` +
        `[mcp] 请在 MCP 客户端配置的 mcpServers.<name>.env 中提供 DATABASE_URL（PostgreSQL 连接串）。\n`,
    );
    process.exit(1);
  }
  const env = parsed.env;

  // 2. MCP 自建 drizzle 连接（import schema.ts 自建、绝不复用 db/index.ts 全局-env 单例）。
  //    池惰性建立；查询/mark handler 经 getContext() 取它（push_event_now 的 dispatchDigest 第三参亦传它）。
  const db = getMcpDb(env.DATABASE_URL);
  // 设置运行上下文一次：各 handler（组 B/C 实现）经 getContext() 取 env + db。
  setContext({ env, db });

  // 3. 建 McpServer + 注册全部 8 工具（统一 registerTool）。
  const server = new McpServer({
    name: 'ai-radar-mcp',
    version: '0.1.0',
  });

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
      },
      // SDK 依 inputSchema 校验入参后调 handler；descriptor.handler 签名 (args, extra)。
      tool.handler,
    );
  }

  // 4. stdio transport + connect（connect 之前已完成 env fail-fast）。
  const transport = new StdioServerTransport();

  // 优雅关闭触发源：transport close（Claude Desktop 退出多为关管道）+ 信号 + stdin end。
  transport.onclose = () => {
    void shutdown('transport close');
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin end'));
  process.stdin.on('close', () => void shutdown('stdin close'));

  await server.connect(transport);
  logErr(`已连接 stdio，注册 ${allTools.length} 个工具。`);
}

main().catch((e) => {
  // 启动期未捕获异常 → stderr + exit(1)（绝不经 stdout）。
  process.stderr.write(
    `[mcp] 启动异常：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
  );
  process.exit(1);
});
