/**
 * 产品中文化落库（capability: product-chinese-digest，design D2/D3）。
 *
 * 关键不变量（绝不可违背）：
 * - 写中文列必须 `UPDATE ai_products ... WHERE product_id = ?`，`set` 中**仅含**
 *   name_zh / tagline_zh；禁止 `INSERT ... ON CONFLICT` 模板；禁止覆盖塌缩/合并/状态列
 *   （name / canonical_domain / github_repo / product_hunt_slug / metadata / merge_conflict /
 *   first_seen_at / last_seen_at / last_pushed_at / representative_raw_item_id）。
 * - 只在 Agent 输出经 Zod 校验通过后才落库（两列同一次原子 UPDATE，绝不存在「name_zh 填而
 *   tagline_zh NULL」的半截态）；绝不写未校验或半截输出。
 * - 中文化**只产展示文本、绝不参与确定性状态判定**（should_push / 推送幂等 / 塌缩合并由
 *   程序 + DB）。
 *
 * 边界：本模块只负责「校验通过 → 落库」的单条写入；候选并集 / 永不向上抛 / 失败告警 /
 *   逐个调用 summarizeProduct 由 pipeline 编排层实现（design D3，**编排契约不同规格**）。
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { aiProducts } from '../../db/schema.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入 / 集成测。 */
type DbLike = typeof defaultDb;

/**
 * 仅写 name_zh + tagline_zh：
 * `UPDATE ai_products SET name_zh = ?, tagline_zh = ? WHERE product_id = ?`。
 *
 * set 中**仅含** name_zh 与 tagline_zh，绝不触碰塌缩/合并/状态列；绝不用 INSERT ... ON CONFLICT。
 * 仅在中文化输出经 Zod 校验通过后调用（传入的 nameZh / taglineZh 须为已校验的非空值）。
 *
 * @param dbh        可注入 db 或事务句柄（默认全局 db）。
 * @param productId  ai_products.product_id（UPDATE 的定位键）。
 * @param nameZh     经校验的中文译名。
 * @param taglineZh  经校验的一句话中文简介。
 */
export async function updateProductZh(
  dbh: DbLike,
  productId: string,
  nameZh: string,
  taglineZh: string,
): Promise<void> {
  await dbh
    .update(aiProducts)
    .set({ nameZh, taglineZh })
    .where(eq(aiProducts.productId, productId));
}
