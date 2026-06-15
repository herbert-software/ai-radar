/**
 * MCP 错误约定 helper（design D5，task 5.2）。
 *
 * 业务可恢复错误（缺 token / 目标 id 不存在 / 动态 import 推送链失败）→ 返回
 * `{ isError:true, content:[{type:'text',text:message}] }`、**不 throw 断 JSON-RPC 连接**。
 * 仅协议级/不可恢复异常才让其冒泡。
 *
 * 注意（design D5 例外）：event 无代表源 url（canonicalUrl 缺）**不算错误**——照常推送/还原、
 * 渲染回退仅标题，**不**走本 helper。本 helper 仅用于真正的业务失败路径（mark_* 命中 0 行、
 * push_event_now 缺 env / 目标不存在等）。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * 构造 isError 结果（人类可读、含可操作信息/缺失 env 名）。
 *
 * @param message 人类可读错误信息（mark_* 提示 id 不存在；push 提示缺失 env 名等）。
 */
export function toIsError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
