/**
 * MCP 工具描述符共享类型（design D1/D5）。
 *
 * 每个 tool 文件导出一个 `McpToolDescriptor`，server.ts 统一 `registerTool(name, config, handler)`。
 *
 * 形态契约（design D5）：
 * - `inputSchema`：zod **raw shape**（`{ k: z.x() }`，**非** `z.object(...)`）；入参由 SDK 依此
 *   **自动校验**，handler 内**不再** `parse(args)`（task 5.1）。
 * - `outputSchema?`：查询工具声明（zod raw shape）；声明则 handler **必须**返回 structuredContent
 *   且被 SDK 强制校验。mark_* 与 push_event_now **不声明**（结果即一句 outcome 文本）。
 * - `annotations`：readOnlyHint / idempotentHint / destructiveHint 等（design D5）。
 * - `handler`：`(args, extra) => CallToolResult | Promise<CallToolResult>`；SDK 已校验入参，
 *   故 handler 第一参为已解析入参（此处用宽松 `Record<string, unknown>` 承载，各 tool 内按需取值）。
 */
import type { z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** zod raw shape（inputSchema / outputSchema 的形态：键 → zod 校验器）。 */
export type ZodRawShape = z.ZodRawShape;

/** 工具 handler：入参已由 SDK 校验，返回 CallToolResult（业务错误走 isError、不 throw）。 */
export type McpToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

/** MCP 工具描述符（每个 tool 文件导出一个；server.ts 统一注册）。 */
export interface McpToolDescriptor {
  /** 工具名（snake_case，对客户端可见）。 */
  name: string;
  /** 工具描述（讲清何时用 + 关键约束）。 */
  description: string;
  /** 入参 zod raw shape（SDK 依此自动校验）。 */
  inputSchema: ZodRawShape;
  /** 出参 zod raw shape（仅查询工具声明；声明则 handler 必返 structuredContent）。 */
  outputSchema?: ZodRawShape;
  /** 工具注解（readOnlyHint/idempotentHint/destructiveHint）。 */
  annotations: ToolAnnotations;
  /** 工具 handler（入参已校验、返回 CallToolResult）。 */
  handler: McpToolHandler;
}
