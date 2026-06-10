/**
 * Drizzle 客户端 —— 全仓库唯一的数据库入口。
 *
 * 稳定接口（组 D 健康检查 db 探测、组 E Value Judge 落库会 import 本模块）：
 * - `db`     ：drizzle 实例（绑定 schema，供类型化查询）。
 * - `pool`   ：底层 node-postgres 连接池（供生命周期管理 / 显式关闭）。
 * - `pingDb` ：轻量连通探测（SELECT 1），供 /health 复用。
 *
 * 连接串来自 env.DATABASE_URL（已在 src/config/env.ts 做启动期校验，缺失即 throw）。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });

export { schema };

/**
 * 轻量数据库连通探测：执行 `SELECT 1`。
 * 成功返回 true；连接失败时抛出底层错误（由调用方决定如何反映为不健康）。
 */
export async function pingDb(): Promise<boolean> {
  await db.execute(sql`SELECT 1`);
  return true;
}
