/**
 * MCP 专用 drizzle 连接（design D1/D8）。
 *
 * **绝不复用 `src/db/index.ts`**：那里 `import { env } from '../config/env.js'` 会触发全局
 * parseEnv（require telegram/product_hunt token 等），崩纯查询。此处只 import `src/db/schema.ts`
 * （纯表定义、零 env）自建 `drizzle(new Pool({ connectionString }), { schema })`，仅需 DATABASE_URL。
 *
 * 连接惰性建立（首次 `getMcpDb()` 调用时建池），让 server.ts 能在 connect 之前做 env fail-fast。
 * 进程退出由 server.ts 优雅关闭统一 `closeMcpDb()`（幂等、只 `pool.end()` 一次）。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../db/schema.js';

/** MCP 自建 drizzle 实例类型（绑定 schema、供类型化查询）。 */
export type McpDb = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | null = null;
let dbInstance: McpDb | null = null;

/**
 * 取 MCP 自建 drizzle 实例（首次调用建池）。
 *
 * @param connectionString PostgreSQL 连接串（来自 MCP 宽松 env 的 DATABASE_URL）。
 */
export function getMcpDb(connectionString: string): McpDb {
  if (dbInstance === null) {
    pool = new Pool({ connectionString });
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

/**
 * 优雅关闭 MCP 自建连接池（幂等）。
 *
 * 多触发源（SIGINT/SIGTERM/stdin close/transport close）汇聚到 shutdown()，
 * 本函数保证底层 `pool.end()` 只执行一次（重复调用直接 resolve）。
 */
export async function closeMcpDb(): Promise<void> {
  const p = pool;
  pool = null;
  dbInstance = null;
  if (p !== null) {
    await p.end();
  }
}

export { schema };
