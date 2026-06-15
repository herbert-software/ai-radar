/**
 * get_source_quality_report —— 源质量报告（design D3/D5，task 3.4）。
 *
 * 按 source 只读聚合：`raw_items` 采集量 + 塌缩入 `ai_news_events` 数 + 被推送数
 * （`COUNT(DISTINCT push_records.target_id WHERE status='success')` 经 event 关联回 source）+
 * 最近活跃时间。**source 归因口径（钉死）**：event↔source 唯一路径为
 * `ai_news_events.representative_raw_item_id → raw_items.source`（raw_items 无 event_id、
 * 无 item_event_relations）；故「塌缩入数/被推送数」按**代表源**归因、**多源塌缩事件仅计代表源**
 * （全源归因留后续）。**不用「入选 Top N 率」**（selectTopN 不落库、不可从 DB 算，以「被推送数」替代）。
 * source 基数有界（采集器级）、无需分页、无入参。
 *
 * 输出契约（design D5）：声明 outputSchema + 返回 structuredContent + 向后兼容 content 文本。
 * annotations.readOnlyHint:true。
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { aiNewsEvents, pushRecords, rawItems } from '../../db/schema.js';
import { getContext } from '../context.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/** 无入参（source 基数有界、无需过滤/分页）。 */
const inputSchema = {};

/** 单源统计视图。 */
const sourceStatSchema = z.object({
  source: z.string(),
  collectedCount: z.number().int().nonnegative(),
  collapsedEventCount: z.number().int().nonnegative(),
  pushedCount: z.number().int().nonnegative(),
  lastActiveAt: z.string().nullable(),
});

/** 出参 zod raw shape（声明 outputSchema → handler 必返 structuredContent）。 */
const outputSchema = {
  sources: z.array(sourceStatSchema),
};

/** 出参完整 DTO 校验器。 */
const outputDtoSchema = z.object(outputSchema);

/** PG COUNT 经 drizzle 读回为 string/number/bigint，统一安全转 number（非有限 → 0）。 */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function handler(): Promise<CallToolResult> {
  try {
    const { db } = getContext();

    // 1. 各 source 的采集量 + 最近活跃时间（按 raw_items.source 聚合）。
    const collectRows = await db
      .select({
        source: rawItems.source,
        collected: sql<number>`count(*)`,
        lastActive: sql<Date | null>`max(${rawItems.fetchedAt})`,
      })
      .from(rawItems)
      .groupBy(rawItems.source);

    // 2. 经代表源归因的「塌缩入事件数」+「被推送数」：
    //    event → 代表 raw_item.source；被推送数 = 该 source 下、有 status='success' 的 event 推送记录的
    //    DISTINCT event_id 数（target_type='event' AND target_id=event_id）。多源塌缩仅计代表源。
    const eventRows = await db
      .select({
        source: rawItems.source,
        collapsed: sql<number>`count(distinct ${aiNewsEvents.eventId})`,
        pushed: sql<number>`count(distinct ${pushRecords.targetId})`,
      })
      .from(aiNewsEvents)
      .innerJoin(rawItems, sql`${aiNewsEvents.representativeRawItemId} = ${rawItems.id}`)
      .leftJoin(
        pushRecords,
        sql`${pushRecords.targetType} = 'event'
          and ${pushRecords.targetId} = ${aiNewsEvents.eventId}
          and ${pushRecords.status} = 'success'`,
      )
      .groupBy(rawItems.source);

    // 3. 以 source 为键合并两组统计（采集统计是全集，事件统计左并入）。
    const byEvent = new Map(
      eventRows.map((r) => [
        r.source,
        { collapsed: toCount(r.collapsed), pushed: toCount(r.pushed) },
      ]),
    );
    const sources = collectRows.map((r) => {
      const ev = byEvent.get(r.source);
      return {
        source: r.source,
        collectedCount: toCount(r.collected),
        collapsedEventCount: ev ? ev.collapsed : 0,
        pushedCount: ev ? ev.pushed : 0,
        lastActiveAt: r.lastActive ? new Date(r.lastActive).toISOString() : null,
      };
    });

    const dto = outputDtoSchema.parse({ sources });
    return {
      structuredContent: dto,
      content: [{ type: 'text', text: JSON.stringify(dto) }],
    };
  } catch (e) {
    return toIsError(
      `生成源质量报告失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export const sourceQualityTool: McpToolDescriptor = {
  name: 'get_source_quality_report',
  description:
    '只读汇总各信息源的质量统计：采集量、塌缩入事件数、被推送数（按代表源归因）、最近活跃时间。' +
    '用于评估各采集源的产出与转化，替代不可从 DB 计算的「入选 Top N 率」。',
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
  },
  handler,
};
