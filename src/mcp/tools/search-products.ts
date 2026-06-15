/**
 * search_ai_products —— 历史产品只读查询（design D3/D5，task 3.3）。
 *
 * 参数化 SQL：`name`/`canonical_domain ILIKE` 分页；`q` 拼 `%q%` 前**转义 LIKE 元字符**（同 events）。
 * 链接经 productCanonicalUrl 严格映射（畸形域降级 null、不裸拼）。
 *
 * 输出契约（design D5）：声明 outputSchema + 返回 structuredContent（DTO，handler zod parse）+
 * 向后兼容 content 文本。annotations.readOnlyHint:true。入参由 SDK 自动校验（handler 不再 parse）。
 */
import { z } from 'zod';
import { and, count, desc, ilike, sql, type SQL } from 'drizzle-orm';
import { aiProducts } from '../../db/schema.js';
import { getContext } from '../context.js';
import { escapeLike } from '../lib/sql-like.js';
import { productCanonicalUrl } from '../lib/canonical-url.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/**
 * 入参 zod raw shape（design D3）：
 * - q?：名称关键词（name ILIKE；拼 %q% 前转义 LIKE 元字符）。
 * - domain?：canonical_domain 关键词（ILIKE）。
 * - limit：默认 20、上限 100；offset：默认 0。
 */
const inputSchema = {
  q: z.string().optional(),
  domain: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
};

/** 单条产品命中视图。 */
const productHitSchema = z.object({
  productId: z.string(),
  name: z.string(),
  canonicalDomain: z.string().nullable(),
  url: z.string().nullable(),
});

/** 出参 zod raw shape（声明 outputSchema → handler 必返 structuredContent）。 */
const outputSchema = {
  total: z.number().int().nonnegative(),
  products: z.array(productHitSchema),
};

/** 出参完整 DTO 校验器。 */
const outputDtoSchema = z.object(outputSchema);

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const q = args.q as string | undefined;
  const domain = args.domain as string | undefined;
  const limit = args.limit as number;
  const offset = args.offset as number;

  try {
    const { db } = getContext();

    const conds: SQL[] = [];
    if (q !== undefined && q !== '') {
      conds.push(ilike(aiProducts.name, `%${escapeLike(q)}%`));
    }
    if (domain !== undefined && domain !== '') {
      conds.push(ilike(aiProducts.canonicalDomain, `%${escapeLike(domain)}%`));
    }
    const whereExpr = conds.length > 0 ? and(...conds) : undefined;

    const totalRows = await db
      .select({ value: count() })
      .from(aiProducts)
      .where(whereExpr);
    const total = totalRows[0]?.value ?? 0;

    // 稳定分页排序：last_seen_at DESC NULLS LAST，再以 product_id 兜底确定性。
    const rows = await db
      .select({
        productId: aiProducts.productId,
        name: aiProducts.name,
        canonicalDomain: aiProducts.canonicalDomain,
      })
      .from(aiProducts)
      .where(whereExpr)
      .orderBy(sql`${aiProducts.lastSeenAt} DESC NULLS LAST`, desc(aiProducts.productId))
      .limit(limit)
      .offset(offset);

    const products = rows.map((r) => ({
      productId: r.productId,
      name: r.name,
      canonicalDomain: r.canonicalDomain,
      url: productCanonicalUrl(r.canonicalDomain),
    }));

    const dto = outputDtoSchema.parse({ total, products });
    return {
      structuredContent: dto,
      content: [{ type: 'text', text: JSON.stringify(dto) }],
    };
  } catch (e) {
    return toIsError(
      `检索历史产品失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export const searchProductsTool: McpToolDescriptor = {
  name: 'search_ai_products',
  description:
    '只读检索历史 AI 产品：按名称关键词或 canonical_domain（ILIKE）分页。链接经严格域名校验拼接，' +
    '畸形域降级为无链接。',
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
  },
  handler,
};
