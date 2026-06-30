/**
 * MCP 测试公共 helper：连真库 + 经 SDK 端到端连一个 in-memory client。
 *
 * 两种被测姿势：
 *   ① 直接调 `xxxTool.handler(args, {})`——验 handler 内部契约（DB 行为、isError、幂等）。
 *      调前须 `setContext({ env, db })` 注入测试 db + 局部宽松 env（含 PUSH_TIMEZONE）。
 *   ② 经真 `McpServer`（registerTool 全部 8 工具，与 server.ts 同口径）+ `Client`（InMemoryTransport
 *      成对）——验 **SDK 层**契约：list_tools、入参依 inputSchema 自动拒、声明 outputSchema 则
 *      structuredContent 被强制校验。
 *
 * 连库照搬既有集成测试模板（drizzle + 测试库 + 唯一前缀隔离 + afterAll 清理）。
 */
// 测试库连接串来自 .env（与既有集成测试同口径）；这些测试不经 config/env.ts 加载 dotenv，
// 故在此显式加载，使 process.env.DATABASE_URL 可用（缺则各套件 skip）。
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as schema from '../../db/schema.js';
import type { McpDb } from '../db.js';
import type { McpEnv } from '../env.js';
import { allTools } from '../tools/index.js';

/** 测试库连接串（缺则套件整体跳过）。 */
export const databaseUrl = process.env.DATABASE_URL;

/** 测试用 pg Pool（缺 DATABASE_URL 时为 null）。 */
export const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

/** 测试用 MCP 自建口径 drizzle 实例（绑定 schema）。 */
export const db: McpDb | null = pool ? drizzle(pool, { schema }) : null;

/** 是否可连真库跑集成测试。 */
export const canRun = Boolean(databaseUrl);

/**
 * 构造测试用 MCP 宽松 env（含 PUSH_TIMEZONE；feishu 字段可覆盖）。
 *
 * @param overrides 覆盖项（如 FEISHU_WEBHOOK_URL/FEISHU_SIGN_SECRET 测多通道解析）。
 */
export function makeEnv(overrides: Partial<McpEnv> = {}): McpEnv {
  return {
    DATABASE_URL: databaseUrl ?? 'postgres://x:x@localhost:5432/x',
    PUSH_TIMEZONE: 'Asia/Shanghai',
    MR_STALENESS_THRESHOLD_DAYS: 30,
    ...overrides,
  };
}

/**
 * 起一个真 McpServer（注册全部 8 工具，与 server.ts 同口径）并经 InMemoryTransport 连一个 Client。
 *
 * 用于验 SDK 层契约（list_tools / 入参自动校验 / outputSchema 强制校验）。调用方负责先 setContext。
 *
 * @returns { client, close }——close 断开两端连接。
 */
export async function connectInMemoryClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'ai-radar-mcp-test', version: '0.0.0-test' });
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
      },
      tool.handler,
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ai-radar-mcp-test-client', version: '0.0.0-test' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
