/**
 * MCP 自带链接还原 helper（design D6，task 2.6）。
 *
 * 复刻两套**机制不同、勿互套**的链接逻辑（均零 env 依赖、查询链 top-level 可用）：
 *   ① loadCanonicalUrls —— event 经 `representative_raw_item_id → raw_items.canonical_url`
 *      读已规范化的原文 url（采集期已规范化、此处不再现场校验；缺则 null）。
 *      复刻 `src/pipeline/run-daily-workflow.ts:loadCanonicalUrls`（私有非导出，不 import）。
 *   ② productCanonicalUrl —— product 的 `canonical_domain` 现拼 `https://` + **严格 URL 校验**
 *      （new URL 校验 host===裸域、无 path/search/hash/凭据，畸形降级 null，绝不裸拼）。
 *      复刻 `src/pipeline/product-digest.ts:selectProductCandidates` 内联映射。
 *
 * **不 import pipeline 文件**：它们 top-level import 全局 env，会崩纯查询。只 import schema.ts（零 env）。
 */
import { inArray } from 'drizzle-orm';
import { aiNewsEvents, rawItems } from '../../db/schema.js';
import type { McpDb } from '../db.js';

/**
 * 把一批 event 补齐 canonical_url（经 representative_raw_item_id → raw_items.canonical_url）。
 *
 * 复刻 run-daily-workflow.ts:loadCanonicalUrls：先按 eventIds 取代表 raw_item_id，
 * 再按 raw_item_id 取 canonical_url；event 无代表源/源无 url → 该 event 映射为 null（非错误）。
 *
 * @param dbh      MCP 自建 drizzle 实例。
 * @param eventIds 要还原 url 的 event_id 列表。
 * @returns        eventId → canonical_url（或 null）的 Map。
 */
export async function loadCanonicalUrls(
  dbh: McpDb,
  eventIds: readonly string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (eventIds.length === 0) return map;

  const events = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      repId: aiNewsEvents.representativeRawItemId,
    })
    .from(aiNewsEvents)
    .where(inArray(aiNewsEvents.eventId, eventIds as string[]));

  const repIds = events
    .map((e) => e.repId)
    .filter((x): x is bigint => x !== null);
  const urlByRawId = new Map<string, string | null>();
  if (repIds.length > 0) {
    const raws = await dbh
      .select({ id: rawItems.id, canonicalUrl: rawItems.canonicalUrl })
      .from(rawItems)
      .where(inArray(rawItems.id, repIds));
    for (const r of raws) urlByRawId.set(r.id.toString(), r.canonicalUrl);
  }
  for (const e of events) {
    map.set(
      e.eventId,
      e.repId !== null ? (urlByRawId.get(e.repId.toString()) ?? null) : null,
    );
  }
  return map;
}

/**
 * product `canonical_domain → canonicalUrl` 严格映射（复刻 product-digest 内联）。
 *
 * canonical_domain 为裸域或 host:port → `https://` + domain；用 new URL 试构造校验：
 * host 须等于裸域（保留合法带端口域，仍挡 scheme/path/凭据/空白等畸形）、pathname==='/'、
 * 无 search/hash；任一不满足或 domain NULL/空/含空白/含 `://` → 降级 null（绝不产生坏链接）。
 *
 * @param domain ai_products.canonical_domain（裸域，可空）。
 * @returns      合法时 `https://domain`，畸形/缺失时 null。
 */
export function productCanonicalUrl(domain: string | null): string | null {
  const d = domain;
  if (d && !/\s/.test(d) && !d.includes('://')) {
    try {
      const u = new URL(`https://${d}`);
      if (u.host === d && u.pathname === '/' && !u.search && !u.hash) {
        return `https://${d}`;
      }
    } catch {
      /* 畸形 → 保持 null */
    }
  }
  return null;
}
