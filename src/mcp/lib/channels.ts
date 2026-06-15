/**
 * MCP 自带「已配置通道集」解析逻辑等价（design D6/D8，task 2.6）。
 *
 * 复刻 `resolveChannelSenders`（run-daily-workflow.ts:637 等三处私有实现）的**通道选择**部分：
 * 恒含 telegram（主链口径 telegram 必配）；feishu 在 `FEISHU_WEBHOOK_URL && FEISHU_SIGN_SECRET`
 * 同时存在时纳入（等价主链 isFeishuEnabled）。可由显式 channel 参数覆盖（push_event_now 传 channel?）。
 *
 * **不在此 import sender 工厂**（`createTelegramSender`/`createFeishuSender` top-level import 全局
 * env + grammy，会崩纯查询）——sender 工厂留 push_event_now handler 内动态 import（见组 C）。
 * 本模块只负责「该往哪些 channel 推」的纯解析，零 env import（读传入的 MCP 宽松 env 值）。
 */
import { CHANNEL, type Channel } from '../../push/targets.js';
import type { McpEnv } from '../env.js';

/**
 * 飞书是否 enabled（等价主链 isFeishuEnabled）：webhook + 签名密钥同时配齐。
 *
 * @param env MCP 宽松 env。
 */
export function isFeishuEnabled(env: McpEnv): boolean {
  return Boolean(env.FEISHU_WEBHOOK_URL && env.FEISHU_SIGN_SECRET);
}

/**
 * 解析目标通道集（复刻主链通道选择逻辑）。
 *
 * - 传入 `channel` → 仅该 channel（push_event_now 的 channel? 过滤）。
 * - 未传 → telegram +（feishu enabled 时）feishu。
 *
 * @param env     MCP 宽松 env（判 feishu enabled）。
 * @param channel 可选显式通道过滤（push_event_now 传入）。
 */
export function resolveChannels(env: McpEnv, channel?: Channel): Channel[] {
  if (channel) return [channel];
  return isFeishuEnabled(env)
    ? [CHANNEL.telegram, CHANNEL.feishu]
    : [CHANNEL.telegram];
}
