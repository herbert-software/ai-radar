/**
 * MCP 运行上下文（design D8）——给各 tool handler 提供共享的宽松 env + 自建 db。
 *
 * 为什么需要：tool 描述符的 handler 签名是 `(args, extra)`（SDK 约定），拿不到 server.ts 里建的
 * db/env。本模块用一个进程级单例上下文承载「已解析的 MCP 宽松 env + MCP 自建 drizzle 实例」，
 * server.ts 启动时 `setContext` 一次，各 handler（组 B/C 实现）`getContext()` 取用。
 *
 * **测试可注入**（组 D）：测试可直接 `setContext({ env, db })` 注入解析后的局部 env + 测试 db，
 * 无需启动真实 stdio server。
 *
 * 本模块零外部副作用、零全局-env import（McpEnv/McpDb 均来自 MCP 自带模块）。
 */
import type { McpEnv } from './env.js';
import type { McpDb } from './db.js';

/** MCP 运行上下文：宽松 env + 自建 db。 */
export interface McpContext {
  env: McpEnv;
  db: McpDb;
}

let current: McpContext | null = null;

/**
 * 设置运行上下文（server.ts 启动时调一次；测试可注入）。
 *
 * @param ctx 已解析的 MCP 宽松 env + MCP 自建 db。
 */
export function setContext(ctx: McpContext): void {
  current = ctx;
}

/**
 * 取运行上下文。
 *
 * @throws 若未先 setContext（编程错误：handler 在 server 启动/测试注入之前被调）。
 */
export function getContext(): McpContext {
  if (current === null) {
    throw new Error(
      'MCP 上下文未初始化：handler 在 setContext 之前被调用（server.ts 启动或测试注入应先 setContext）。',
    );
  }
  return current;
}
