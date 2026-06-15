/**
 * mark_event_not_relevant —— 标记事件不相关使其退出推送候选（design D4/D5，task 4.1）。
 *
 * `UPDATE ai_news_events SET should_push=false WHERE event_id=?`。**ai_news_events 无 metadata 列**，
 * 故只置 should_push、`reason` 仅记 stderr 日志/返回信息、**不入 DB**（不新增列、不误用 main_entities）。
 * 命中 0 行（eventId 不存在）→ 返回 isError:true + 提示（用 toIsError），**不静默成功**。
 * 稳定性：Value Judge 只处理未评分事件，已评分 should_push=false 不被 re-judge 覆盖。
 *
 * 输出契约（design D5）：结果即一句 outcome，**只返回 content 文本、不声明 outputSchema**。
 * annotations：readOnlyHint:false, idempotentHint:true（幂等覆盖、非破坏）。
 * 入参由 SDK 自动校验（handler 不再 parse）。
 *
 * 本骨架由组 A 建；handler 实现由组 C 填（暂返 NOT_IMPLEMENTED 占位）。
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiNewsEvents } from '../../db/schema.js';
import { getContext } from '../context.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/** 入参 zod raw shape：eventId 必填；reason 可选（仅日志/返回、不入 DB）。 */
const inputSchema = {
  eventId: z.string().min(1),
  reason: z.string().optional(),
};

export const markEventTool: McpToolDescriptor = {
  name: 'mark_event_not_relevant',
  description:
    '把指定事件标记为不相关（should_push=false），使其退出后续日报推送候选。reason 仅记录于日志/返回，' +
    '不写入数据库。事件不存在则返回错误。幂等。',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
  },
  handler: async (args): Promise<CallToolResult> => {
    // 入参已由 SDK 依 inputSchema 校验，此处直接取值（不重复 parse）。
    const eventId = args.eventId as string;
    const reason = args.reason as string | undefined;

    const { db } = getContext();
    // 确定性 DB 写：仅置 should_push=false（ai_news_events 无 metadata 列、reason 不入库）。
    // `.returning` 取受影响行，用以区分命中/未命中（命中 0 行 = eventId 不存在）。
    const updated = await db
      .update(aiNewsEvents)
      .set({ shouldPush: false })
      .where(eq(aiNewsEvents.eventId, eventId))
      .returning({ eventId: aiNewsEvents.eventId });

    if (updated.length === 0) {
      // 不静默成功：目标不存在是业务可恢复错误 → isError（不 throw 断连）。
      return toIsError(`事件不存在：event_id=${eventId}，未做任何变更。`);
    }

    // reason 仅记 stderr 日志（不入 DB；stdout 是 JSON-RPC 专用通道，禁污染）。
    if (reason) {
      process.stderr.write(
        `[mcp] mark_event_not_relevant event_id=${eventId} reason=${reason}\n`,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `已标记事件 ${eventId} 为不相关（should_push=false），将退出后续日报推送候选。` +
            (reason ? `（原因：${reason}）` : ''),
        },
      ],
    };
  },
};
