/**
 * get_today_ai_digest —— 查当日**已推**日报（design D2/D5，task 3.1）。
 *
 * 以 `push_records`（push_date=今天〔MCP env PUSH_TIMEZONE〕、status='success'）为准还原已推内容，
 * **不重跑 selectTopN**：channel 默认取库中当日实际有 success 的 distinct channel（不依赖进程
 * env 的 isFeishuEnabled），可传 channel 过滤；按 target_type join ai_news_events（要闻段）/
 * ai_products（新品段）；event url 经 MCP loadCanonicalUrls（缺则省略）、product 链接经
 * **product-digest 同一 `resolveProductUrl` 回退链**（`canonical_domain` → `github_repo` →
 * `product_hunt_slug`，含 URL/段校验、畸形降级 null、不裸拼），忠实于实际已推内容——否则
 * github-only/PH-only 产品「推时有链接、查时无链接」；orphan 跳过；当日无 success → 空 +
 * 文本「今日尚未推送」。**仅 get_today 改回退链**（其有「忠实于已推」不变量）；search_ai_products
 * 保留既有 `productCanonicalUrl`（canonical_domain-only，历史检索无忠实义务）。
 *
 * 输出契约（design D5）：声明 outputSchema + handler 返回 structuredContent（DTO，handler 内 zod
 * parse）+ 向后兼容 content 文本（JSON.stringify(dto)）。annotations.readOnlyHint:true。
 *
 * 入参由 SDK 依 inputSchema 自动校验（task 5.1，handler 内不再 parse）。
 */
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { channelEnum, TARGET_TYPE, type Channel } from '../../push/targets.js';
import { aiNewsEvents, aiProducts, pushRecords } from '../../db/schema.js';
import { getContext } from '../context.js';
import { getPushDate } from '../lib/push-date.js';
import { loadCanonicalUrls } from '../lib/canonical-url.js';
import { resolveProductUrl } from '../../collectors/product-keys.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/** 入参 zod raw shape：可选 channel 过滤（默认取当日实际 success 的 distinct channel）。 */
const inputSchema = {
  channel: channelEnum.optional(),
};

/**
 * 单条已推条目（要闻段 event / 新品段 product 共用最小视图）。
 *
 * `tagline`：产品中文简介（来自 ai_products.tagline_zh），缺则 null；要闻段 event 恒 null
 * （events 简介走 headlineZh 渲染、不经此字段）。**近似语义**：中文字段反映查询时
 * ai_products 当前值（push_records 不存渲染文本快照），属既有「join 当前值还原」近似、非新缺陷。
 */
const digestItemSchema = z.object({
  targetId: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  tagline: z.string().nullable(),
});

/** 出参 zod raw shape（声明 outputSchema → handler 必返 structuredContent 并被 SDK 校验）。 */
const outputSchema = {
  pushDate: z.string(),
  channels: z.array(channelEnum),
  events: z.array(digestItemSchema),
  products: z.array(digestItemSchema),
};

/** 出参完整 DTO 校验器（handler 内对组装结果做 zod parse 后放 structuredContent）。 */
const outputDtoSchema = z.object(outputSchema);

/**
 * 还原当日已推日报。
 *
 * 完全以 push_records（push_date=今天、status='success'）为准 join 还原，**绝不调 selectTopN 重选**。
 */
async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const channelFilter = args.channel as Channel | undefined;

  try {
    const { env, db } = getContext();
    const pushDate = getPushDate(new Date(), env.PUSH_TIMEZONE);

    // 1. 当日 success 的推送记录（可按 channel 过滤）。
    const whereConds = [
      eq(pushRecords.pushDate, pushDate),
      eq(pushRecords.status, 'success'),
    ];
    if (channelFilter) {
      whereConds.push(eq(pushRecords.channel, channelFilter));
    }
    const records = await db
      .select({
        targetType: pushRecords.targetType,
        targetId: pushRecords.targetId,
        channel: pushRecords.channel,
      })
      .from(pushRecords)
      .where(and(...whereConds));

    // 2. 当日无 success → 空结果 + 「今日尚未推送」。
    if (records.length === 0) {
      const dto = outputDtoSchema.parse({
        pushDate,
        channels: [],
        events: [],
        products: [],
      });
      return {
        structuredContent: dto,
        content: [{ type: 'text', text: `今日尚未推送（push_date=${pushDate}）。` }],
      };
    }

    // 3. 库中当日实际 success 的 distinct channel（不依赖进程 env）；channel 过滤已在 SQL 端应用。
    const channels = [...new Set(records.map((r) => r.channel))]
      .map((c) => channelEnum.safeParse(c))
      .filter((p): p is { success: true; data: Channel } => p.success)
      .map((p) => p.data);

    // 4. 按 target_type 收集 distinct target_id（多 channel 推同一 target 只还原一次）。
    const eventIds = [
      ...new Set(
        records
          .filter((r) => r.targetType === TARGET_TYPE.event)
          .map((r) => r.targetId),
      ),
    ];
    const productIds = [
      ...new Set(
        records
          .filter((r) => r.targetType === TARGET_TYPE.product)
          .map((r) => r.targetId),
      ),
    ];

    // 5. 要闻段：join ai_news_events 还原标题 + canonical_url（orphan 自然不在查询结果里 → 跳过）。
    const events: Array<{
      targetId: string;
      title: string | null;
      url: string | null;
      tagline: string | null;
    }> = [];
    if (eventIds.length > 0) {
      const rows = await db
        .select({
          eventId: aiNewsEvents.eventId,
          headlineZh: aiNewsEvents.headlineZh,
          representativeTitle: aiNewsEvents.representativeTitle,
        })
        .from(aiNewsEvents)
        // P3 tombstone 排除（合并核心闭环，纵深防御）：今日 push_date 的 success 集本只含存活者
        // （tombstone 已被 value-judge/Top N 排除、当日绝不新推，spec 传递性安全注），但 tombstone 可能
        // 保留被合并前某历史 push_date 的 success——故仍显式排除，绝不向 agent/用户还原重复 tombstone 行。
        .where(and(inArray(aiNewsEvents.eventId, eventIds), isNull(aiNewsEvents.mergedInto)));
      const urlMap = await loadCanonicalUrls(
        db,
        rows.map((r) => r.eventId),
      );
      // 保持 push_records 的 distinct 顺序，仅还原仍存在的 event（orphan 跳过）。
      const rowById = new Map(rows.map((r) => [r.eventId, r]));
      for (const id of eventIds) {
        const r = rowById.get(id);
        if (!r) continue; // orphan：push_records success 但 event 行已删 → 跳过、不报错。
        events.push({
          targetId: r.eventId,
          title: r.headlineZh ?? r.representativeTitle,
          url: urlMap.get(r.eventId) ?? null,
          tagline: null, // 要闻段无产品简介字段；events 简介经 title(headlineZh) 还原。
        });
      }
    }

    // 6. 新品段：join ai_products 还原名称（中文译名优先）+ 中文简介 + 链接回退链（忠实于已推）。
    //    SELECT 须取三键 canonical_domain/github_repo/product_hunt_slug，否则换 resolveProductUrl
    //    仍会因入参缺失丢 github-only/PH-only 产品的链接。
    const products: Array<{
      targetId: string;
      title: string | null;
      url: string | null;
      tagline: string | null;
    }> = [];
    if (productIds.length > 0) {
      const rows = await db
        .select({
          productId: aiProducts.productId,
          name: aiProducts.name,
          nameZh: aiProducts.nameZh,
          taglineZh: aiProducts.taglineZh,
          canonicalDomain: aiProducts.canonicalDomain,
          githubRepo: aiProducts.githubRepo,
          productHuntSlug: aiProducts.productHuntSlug,
        })
        .from(aiProducts)
        .where(inArray(aiProducts.productId, productIds));
      const rowById = new Map(rows.map((r) => [r.productId, r]));
      for (const id of productIds) {
        const r = rowById.get(id);
        if (!r) continue; // orphan 跳过。
        products.push({
          targetId: r.productId,
          // 中文译名优先、缺则回退英文 name（join 当前 ai_products 值，非推送快照、固有近似）。
          title: r.nameZh ?? r.name,
          // 与 push 同一 resolveProductUrl 回退链：canonical_domain → github_repo →
          // product_hunt_slug，畸形降级 null、不裸拼，忠实于实际已推内容。
          url: resolveProductUrl(r.canonicalDomain, r.githubRepo, r.productHuntSlug),
          tagline: r.taglineZh, // 中文简介，缺则 null。
        });
      }
    }

    // 7. 出参 DTO zod parse 后放 structuredContent（+ 兼容 content 文本）。
    const dto = outputDtoSchema.parse({ pushDate, channels, events, products });
    return {
      structuredContent: dto,
      content: [{ type: 'text', text: JSON.stringify(dto) }],
    };
  } catch (e) {
    // DB 连接/查询失败或出参 DTO zod parse 失败（脏行）→ isError，不冒泡断连。
    return toIsError(
      `查询当日已推日报失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export const getTodayTool: McpToolDescriptor = {
  name: 'get_today_ai_digest',
  description:
    '查当日「已推送」的 AI 日报（要闻段 + 新品段），忠实还原 push_records 中 success 的事实，' +
    '不重跑 Top N 选择。channel 默认取当日实际推送过的所有通道；当日未推则返回空 + 「今日尚未推送」。',
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
  },
  handler,
};
