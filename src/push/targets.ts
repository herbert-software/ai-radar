/**
 * 推送幂等四元组的枚举收口（platform-foundation「数据库 Schema 可迁移」枚举收口需求）。
 *
 * `push_records` 的 `target_type` 与 `channel` 是裸 `VARCHAR`，DB 不挡拼写错——某处误拼
 * （如 `'alerts'`、`'Event'`）会使幂等四元组静默分裂成两个命名空间、绕过去重而漏推/重推。
 * 故由本模块用 **Zod enum** 集中定义权威全集，所有推送路径（dispatcher / 候选窗口 / 各
 * target_type 推送入口）统一引用本处常量，**禁止散落字面量**。新增 target_type/channel
 * 必须先扩此处枚举再使用。
 *
 * 权威全集（spec platform-foundation 显式声明）：
 * - `target_type` = `{event, product, alert, weekly, experience}`
 *   —— `paper`/`repo` 不在范围（arXiv 论文仅采集沉淀、不推送）；`alert`/`weekly` 是 P2
 *      相对 QA §8.6 注释的有意新增（实时告警 / 周报各需独立幂等命名空间）；`experience`
 *      是 add-ai-blogger-experience-mining 新增（AI 博主经验的实践锦囊推送需独立幂等命名空间）。
 * - `channel` = `{telegram, feishu}`
 *   —— Telegram 必配、飞书可选。
 */
import { z } from 'zod';

/** 推送目标类型枚举（权威全集）。 */
export const targetTypeEnum = z.enum([
  'event',
  'product',
  'alert',
  'weekly',
  'experience',
]);
/** 推送通道枚举（本期权威全集）。 */
export const channelEnum = z.enum(['telegram', 'feishu']);

/** 推送目标类型（`push_records.target_type`）。 */
export type TargetType = z.infer<typeof targetTypeEnum>;
/** 推送通道（`push_records.channel`）。 */
export type Channel = z.infer<typeof channelEnum>;

/** 命名常量：各推送路径引用这些常量而非字面量，杜绝拼写错分裂命名空间。 */
export const TARGET_TYPE = {
  event: 'event',
  product: 'product',
  alert: 'alert',
  weekly: 'weekly',
  experience: 'experience',
} as const satisfies Record<TargetType, TargetType>;

export const CHANNEL = {
  telegram: 'telegram',
  feishu: 'feishu',
} as const satisfies Record<Channel, Channel>;
