/**
 * push_event_now —— 人工即时推送单事件，复用既有 dispatcher 幂等状态机（design D4/D8，task 4.3）。
 *
 * 读 event（不存在→isError）→ 构造单元素 SelectedEvent（canonicalUrl 经 MCP loadCanonicalUrls
 * 等价填、缺则无链接——非错误）→ **handler 内 `await import('../../push/dispatcher.js')` + 动态
 * import sender 工厂（telegram/feishu）惰性加载推送链** → 调
 * `dispatchDigest([event], { now, sender, channel, targetType:'event' }, mcpDb)`（dbh 传 MCP 自建
 * 连接、单段 renderDigest 非日报双段）。复用幂等（该 channel 已 success → 唯一键跳过）。
 *
 * **N2 / D8 关键**：本骨架顶部**绝不 static import** dispatcher/telegram/feishu（它们 top-level
 * import 全局 env，会崩纯查询）；全部推送链在 **handler 内动态 import**。动态 import specifier 用
 * `.js` 扩展（NodeNext）；`try { const { dispatchDigest } = await import('../../push/dispatcher.js');
 * … } catch` 包整段（import + 调用），env parseEnv 崩与模块解析失败统一兜 isError（含缺失 env 名、
 * 按 channel 报）。各 channel 独立 try/catch 隔离（一个失败不拖另一个）。纯查询不调本工具则永不加载
 * 推送链、不崩。
 *
 * 输出契约（design D5）：结果即各 channel outcome，**只返回 content 文本、不声明 outputSchema**。
 * annotations：readOnlyHint:false, destructiveHint:true（真发外部消息）+ idempotentHint:true（dispatcher 幂等）。
 *
 * 本骨架由组 A 建；handler 实现由组 C 填（动态 import 推送链 + 各 channel 隔离；暂返 NOT_IMPLEMENTED 占位）。
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { aiNewsEvents } from '../../db/schema.js';
import { CHANNEL, channelEnum, type Channel } from '../../push/targets.js';
import { getContext } from '../context.js';
import { loadCanonicalUrls } from '../lib/canonical-url.js';
import { resolveChannels } from '../lib/channels.js';
import { toIsError } from '../lib/errors.js';
import type { SelectedEvent } from '../../selection/top-n.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/** 入参 zod raw shape：eventId 必填；channel 可选（默认所有已配置通道）。 */
const inputSchema = {
  eventId: z.string().min(1),
  channel: channelEnum.optional(),
};

/**
 * 在单个 channel 上推送一个事件——惰性加载推送链并复用 dispatchDigest 幂等状态机。
 *
 * 整段（动态 import dispatcher + sender 工厂 + dispatch 调用）用一个 try/catch 包裹：
 * dispatcher→db/index.ts/push-date.ts 的全局 parseEnv 崩、sender 工厂缺 token、发送失败统一
 * 兜成人类可读的失败文案（含缺失/相关 env 名提示），**不 throw 断 JSON-RPC 连接**。
 * 调用方对每个 channel 独立调用本函数，一个 channel 失败不拖累其它。
 *
 * @param event   要推送的单元素事件视图（canonicalUrl 已经 loadCanonicalUrls 等价填）。
 * @param channel 目标通道。
 * @param now     参考时刻（决定 push_date，复用幂等）。
 * @returns       该 channel 的人类可读 outcome 文本（成功/跳过/失败）。
 */
async function pushOnChannel(
  event: SelectedEvent,
  channel: Channel,
  now: Date,
): Promise<string> {
  try {
    // 动态 import 推送链（.js 扩展，NodeNext）——纯查询不调本工具则永不加载、不触发全局 parseEnv。
    const { dispatchDigest } = await import('../../push/dispatcher.js');
    // 按 channel 动态 import 对应 sender 工厂（telegram/feishu 顶层 import 全局 env+grammy/crypto）。
    const sender =
      channel === CHANNEL.feishu
        ? (await import('../../push/feishu.js')).createFeishuSender()
        : (await import('../../push/telegram.js')).createTelegramSender();

    // dbh 传 MCP 自建连接（避免 dispatcher 用其全局单例池）；targetType 固定 'event'、单段 renderDigest。
    const result = await dispatchDigest(
      [event],
      { now, sender, channel, targetType: 'event' },
      getContext().db,
    );

    if (result.outcome === 'sent') {
      return `[${channel}] 已推送（push_date=${result.pushDate}）。`;
    }
    if (result.outcome === 'skipped') {
      // 该 channel 该事件已 success → 唯一键跳过（复用幂等）。
      return `[${channel}] 已跳过：该事件此前已在本通道成功推送过（幂等）。`;
    }
    return `[${channel}] 推送失败（push_date=${result.pushDate}），记录已置 failed，可稍后重试。`;
  } catch (error) {
    // 动态 import 期全局 parseEnv 崩（缺 REDIS_URL/LLM_*/PRODUCT_HUNT_TOKEN/TELEGRAM_* 等任一）、
    // sender 工厂缺 token、发送异常 → 统一兜文案（含原始错误信息，通常含缺失变量名）。
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[mcp] push_event_now channel=${channel} 失败：${message}\n`,
    );
    return `[${channel}] 推送未完成：${message}`;
  }
}

export const pushEventNowTool: McpToolDescriptor = {
  name: 'push_event_now',
  description:
    '对指定事件立即触发一次推送（单段要闻 digest），复用既有 dispatchDigest 幂等状态机（该通道已成功' +
    '推过则跳过）。会真实发送外部消息。需配齐与 worker 同的全部推送相关 env（缺则该通道返回错误）。',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  handler: async (args): Promise<CallToolResult> => {
    // 入参已由 SDK 依 inputSchema 校验，此处直接取值（不重复 parse）。
    const eventId = args.eventId as string;
    const channel = args.channel as Channel | undefined;

    const { env, db } = getContext();

    // 读 event（取拼消息所需字段）；不存在 → isError（不 throw）。
    // P3 tombstone 排除（合并核心闭环）：SELECT 加 `merged_into IS NULL`——命中 tombstone（被合并掉的
    // 死 event_id）时查不到、走下方「不存在」分支，不手动推 tombstone（spec「tombstone 对所有下游
    // 消费者不可见」：push-event-now SELECT 即排除、不手动推 tombstone）。
    const rows = await db
      .select({
        eventId: aiNewsEvents.eventId,
        representativeTitle: aiNewsEvents.representativeTitle,
        summaryZh: aiNewsEvents.summaryZh,
        headlineZh: aiNewsEvents.headlineZh,
        publishedAt: aiNewsEvents.publishedAt,
      })
      .from(aiNewsEvents)
      .where(and(eq(aiNewsEvents.eventId, eventId), isNull(aiNewsEvents.mergedInto)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return toIsError(`事件不存在或已被合并：event_id=${eventId}，无法推送。`);
    }

    // 经 loadCanonicalUrls 等价填原文链接；缺（无代表源 / 源无 url）则无链接——非错误，照推。
    const urlMap = await loadCanonicalUrls(db, [eventId]);
    const event: SelectedEvent = {
      eventId: row.eventId,
      representativeTitle: row.representativeTitle,
      summaryZh: row.summaryZh,
      headlineZh: row.headlineZh,
      canonicalUrl: urlMap.get(eventId) ?? null,
      publishedAt: row.publishedAt,
      // rankScore 仅供可观测/排序、单事件推送无意义，置 0 占位。
      rankScore: 0,
    };

    // 解析目标通道集：传 channel 则仅该通道；未传则 telegram +（feishu enabled 时）feishu。
    const channels = resolveChannels(env, channel);
    const now = new Date();

    // 各 channel 独立 try/catch 隔离（在 pushOnChannel 内）——一个失败不拖累另一个。
    const outcomes: string[] = [];
    for (const ch of channels) {
      outcomes.push(await pushOnChannel(event, ch, now));
    }

    return {
      content: [{ type: 'text', text: outcomes.join('\n') }],
    };
  },
};
