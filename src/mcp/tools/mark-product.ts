/**
 * mark_product_interesting —— 标记产品有趣（写 metadata，design D4/D5，task 4.2）。
 *
 * `ai_products` **有 metadata 列**，原子 merge：
 * `UPDATE ai_products SET metadata = COALESCE(metadata,'{}'::jsonb) ||
 *   jsonb_build_object('interesting', jsonb_build_object('at', now, 'note', note))
 *   WHERE product_id=?`；幂等、不加列。命中 0 行（productId 不存在）→ isError:true（用 toIsError）。
 *
 * 输出契约（design D5）：结果即一句 outcome，**只返回 content 文本、不声明 outputSchema**。
 * annotations：readOnlyHint:false, idempotentHint:true。入参由 SDK 自动校验（handler 不再 parse）。
 *
 * 本骨架由组 A 建；handler 实现由组 C 填（暂返 NOT_IMPLEMENTED 占位）。
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiProducts } from '../../db/schema.js';
import { getContext } from '../context.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/** 入参 zod raw shape：productId 必填；note 可选（写入 metadata.interesting.note）。 */
const inputSchema = {
  productId: z.string().min(1),
  note: z.string().optional(),
};

export const markProductTool: McpToolDescriptor = {
  name: 'mark_product_interesting',
  description:
    '把指定产品标记为「有趣」：在 ai_products.metadata 原子 merge 写入 interesting（含时间/备注），' +
    '不新增列、不触 LLM。产品不存在则返回错误。幂等。',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
  },
  handler: async (args): Promise<CallToolResult> => {
    // 入参已由 SDK 依 inputSchema 校验，此处直接取值（不重复 parse）。
    const productId = args.productId as string;
    const note = args.note as string | undefined;

    const { db } = getContext();
    // 确定性 DB 写：jsonb 原子 merge（COALESCE 兜空 metadata，`||` 覆盖 interesting 键 → 幂等）。
    // note 经占位符绑定（参数化、禁拼 SQL）；缺省时写 SQL NULL。时间用库端 now()，与库时钟一致。
    const updated = await db
      .update(aiProducts)
      .set({
        metadata: sql`COALESCE(${aiProducts.metadata}, '{}'::jsonb) || jsonb_build_object('interesting', jsonb_build_object('at', now(), 'note', ${note ?? null}::text))`,
      })
      .where(eq(aiProducts.productId, productId))
      .returning({ productId: aiProducts.productId });

    if (updated.length === 0) {
      // 不静默成功：目标不存在是业务可恢复错误 → isError（不 throw 断连）。
      return toIsError(`产品不存在：product_id=${productId}，未做任何变更。`);
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `已标记产品 ${productId} 为「有趣」（写入 metadata.interesting）。` +
            (note ? `（备注：${note}）` : ''),
        },
      ],
    };
  },
};
