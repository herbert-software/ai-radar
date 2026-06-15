/**
 * MCP 专用宽松 env 解析（design D8）。
 *
 * 为什么不复用 `src/config/env.ts`：那里 `export const env = parseEnv(process.env)`
 * 在 import 期即跑全量校验，TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / PRODUCT_HUNT_TOKEN /
 * REDIS_URL / LLM_* 全 required——纯查询用户（只配 DATABASE_URL）一旦 import 即崩。
 * MCP 查询链「纯查询只需 DATABASE_URL」是硬契约，故此处自带一套**轻量**解析：
 *
 * - 只硬性 require `DATABASE_URL`（**保留与主应用同口径的形态校验**：非空 + 合法连接串）；
 * - telegram / feishu / product_hunt / redis / llm 等一律 optional（缺也能启查询）；
 * - `PUSH_TIMEZONE` optional、default `Asia/Shanghai`（与主链 push_date 写入口径同源、防时区漂移）。
 *
 * 本模块**零外部副作用**：不建连接、不读取除 process.env 外的任何资源；可被查询链 top-level 安全 import。
 */
import { z } from 'zod';

/**
 * MCP 宽松 env schema。
 * DATABASE_URL 校验对齐 `src/config/env.ts`（min(1) + url()），其余全 optional。
 */
const mcpEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL 缺失：需提供 PostgreSQL 连接串')
    .url('DATABASE_URL 必须是合法 URL（如 postgres://user:pass@host:5432/db）'),
  // push_date 与查询「今天」口径同源此时区（与主链 PUSH_TIMEZONE 同名同义、default 同值）。
  PUSH_TIMEZONE: z.string().min(1).default('Asia/Shanghai'),
  // 飞书 webhook + 签名密钥（可选）：仅用于 resolveChannelSenders 等价逻辑判 feishu 是否 enabled。
  // 真正的 sender 工厂由 push_event_now handler 动态 import，本处不读其内容做发送。
  FEISHU_WEBHOOK_URL: z.string().url().optional(),
  FEISHU_SIGN_SECRET: z.string().min(1).optional(),
});

/** MCP 宽松 env 类型。 */
export type McpEnv = z.infer<typeof mcpEnvSchema>;

/**
 * 解析 MCP 宽松 env。
 *
 * 成功返回 `{ ok: true, env }`；DATABASE_URL 缺失/畸形返回 `{ ok: false, message }`
 * （由 server.ts 在 connect 之前写 stderr + exit(1)，**绝不经 stdout**）。
 * 不在此处直接 throw / exit，留给调用方控制启动期 fail-fast 路径与文案。
 *
 * @param raw 原始环境变量（默认 process.env；测试可注入）。
 */
export function parseMcpEnv(
  raw: NodeJS.ProcessEnv = process.env,
): { ok: true; env: McpEnv } | { ok: false; message: string } {
  const result = mcpEnvSchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message };
  }
  return { ok: true, env: result.data };
}
