/**
 * search_ai_events —— 历史事件只读查询（design D3/D5，task 3.2）。
 *
 * 参数化 SQL（drizzle 占位符、禁字符串拼 SQL）：`representative_title/summary_zh ILIKE` +
 * `published_at` 时间窗 + `importance_score>=`，`ORDER BY published_at DESC NULLS LAST` 分页。
 * `q` 拼 `%q%` 前**转义 LIKE 元字符 `%`/`_`/`\`**（防字面通配符致全表扫描）。
 * **`ai_news_events` 无 source 列、不按 source 过滤事件**（源维度见 get_source_quality_report）。
 *
 * 输出契约（design D5）：声明 outputSchema + 返回 structuredContent（DTO，handler zod parse）+
 * 向后兼容 content 文本。annotations.readOnlyHint:true。入参由 SDK 自动校验（handler 不再 parse）。
 */
import { z } from 'zod';
import { and, count, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { aiNewsEvents } from '../../db/schema.js';
import { getContext } from '../context.js';
import { escapeLike } from '../lib/sql-like.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/**
 * 入参 zod raw shape（design D3）：
 * - q?：关键词（标题/摘要 ILIKE；拼 %q% 前转义 LIKE 元字符）。
 * - since?/until?：published_at 时间窗（ISO 8601 datetime 串）。
 * - minImportance?：importance_score 下限。
 * - limit：默认 20、上限 100；offset：默认 0。
 */
const inputSchema = {
  q: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  minImportance: z.number().min(0).max(100).optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
};

/** 单条事件命中视图。 */
const eventHitSchema = z.object({
  eventId: z.string(),
  representativeTitle: z.string().nullable(),
  summaryZh: z.string().nullable(),
  importanceScore: z.number().nullable(),
  publishedAt: z.string().nullable(),
});

/** 出参 zod raw shape（声明 outputSchema → handler 必返 structuredContent）。 */
const outputSchema = {
  total: z.number().int().nonnegative(),
  events: z.array(eventHitSchema),
};

/** 出参完整 DTO 校验器。 */
const outputDtoSchema = z.object(outputSchema);

/** NUMERIC 列经 drizzle 读回为字符串，转 number；NULL / 非有限 → null（忠实呈现缺分）。 */
function numOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const q = args.q as string | undefined;
  const since = args.since as string | undefined;
  const until = args.until as string | undefined;
  const minImportance = args.minImportance as number | undefined;
  const limit = args.limit as number;
  const offset = args.offset as number;

  try {
    const { db } = getContext();

    // 参数化过滤条件（全部经 drizzle 占位符，禁字符串拼 SQL）。
    const conds: SQL[] = [];
    if (q !== undefined && q !== '') {
      const pattern = `%${escapeLike(q)}%`;
      const kw = or(
        ilike(aiNewsEvents.representativeTitle, pattern),
        ilike(aiNewsEvents.summaryZh, pattern),
      );
      if (kw) conds.push(kw);
    }
    if (since !== undefined) {
      conds.push(gte(aiNewsEvents.publishedAt, new Date(since)));
    }
    if (until !== undefined) {
      conds.push(lte(aiNewsEvents.publishedAt, new Date(until)));
    }
    if (minImportance !== undefined) {
      // NUMERIC 列比较传字符串（与主链口径一致）。
      conds.push(gte(aiNewsEvents.importanceScore, String(minImportance)));
    }
    const whereExpr = conds.length > 0 ? and(...conds) : undefined;

    // total：同条件下的总命中数（供分页提示）。
    const totalRows = await db
      .select({ value: count() })
      .from(aiNewsEvents)
      .where(whereExpr);
    const total = totalRows[0]?.value ?? 0;

    // 分页结果：published_at DESC NULLS LAST。
    const rows = await db
      .select({
        eventId: aiNewsEvents.eventId,
        representativeTitle: aiNewsEvents.representativeTitle,
        summaryZh: aiNewsEvents.summaryZh,
        importanceScore: aiNewsEvents.importanceScore,
        publishedAt: aiNewsEvents.publishedAt,
      })
      .from(aiNewsEvents)
      .where(whereExpr)
      .orderBy(sql`${aiNewsEvents.publishedAt} DESC NULLS LAST`)
      .limit(limit)
      .offset(offset);

    const events = rows.map((r) => ({
      eventId: r.eventId,
      representativeTitle: r.representativeTitle,
      summaryZh: r.summaryZh,
      importanceScore: numOrNull(r.importanceScore),
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    }));

    const dto = outputDtoSchema.parse({ total, events });
    return {
      structuredContent: dto,
      content: [{ type: 'text', text: JSON.stringify(dto) }],
    };
  } catch (e) {
    return toIsError(
      `检索历史事件失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export const searchEventsTool: McpToolDescriptor = {
  name: 'search_ai_events',
  description:
    '只读检索历史 AI 事件：关键词（标题/摘要 ILIKE）、published_at 时间窗、importance 阈值、分页。' +
    '不支持按来源过滤（事件无 source 维度，源统计请用 get_source_quality_report）。',
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
  },
  handler,
};
