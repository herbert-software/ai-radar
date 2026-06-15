/**
 * 确定性产品塌缩（任务 7.3 / 7.4，product-discovery「ai_products 硬规则产品合并」）。
 *
 * 把 `raw_items(raw_type='product')` 的产品条目塌缩进 `ai_products`，**仅以程序与数据库
 * 唯一约束做硬规则合并，绝不交给 LLM 判断**。合并键为 `canonical_domain` / `github_repo` /
 * `product_hunt_slug` 三个独立 UNIQUE 约束。
 *
 * 不变量（绝不可违背，spec product-discovery / design D4）：
 * - 只读未塌缩过的 product 行（`raw_type='product' AND collapsed=false`），塌缩成功（INSERT /
 *   UPDATE / 标 merge_conflict 任一终态）后置该 raw_item `collapsed=true`，避免每轮无界重读重塌。
 * - 事务内对**全部非空归一键各 `SELECT ... FOR UPDATE`** 收集命中 product_id 集合——**不按优先级
 *   短路只查第一个命中键**（短路会漏掉其余键命中的孤儿行）；按命中 product_id 升序加锁（确定性全序）
 *   防两并发塌缩按不同键顺序加锁互相死锁。产品塌缩由单实例承载（与 arXiv 单实例假设一致）。
 * - 据命中集合 size 分流：size=0 → INSERT；size=1 → UPDATE（只累加 last_seen 类、记
 *   representative_raw_item_id，**禁止覆盖 product_id**）；size>1 → 多键命中多行冲突分支。
 * - INSERT **必填 name（NOT NULL）**：取 raw_item.title（即 PH 产品名），缺失兜底 slug → domain，
 *   **绝不留空**致 INSERT 因 NOT NULL 约束失败。
 * - NULL 键不参与约束（Postgres `UNIQUE(col, NULL)` 放行多行的静默失效防护）。
 * - canonical_domain 由 URL 规范化纯函数提取；github_repo 归一为 owner/name；slug 取 PH 原生 slug。
 *
 * 多键命中多行冲突（size>1，task 7.4）：在涉及各行 metadata 标记 `merge_conflict` + 冲突对方
 * product_id 集合 + 告警，**不静默择一 upsert、不留孤儿行**；同冲突组下轮再命中只更新不重复告警
 * （已标记同组冲突时不再刷告警）。跨行传递合并（合并多行为一行并迁移引用）留 P3。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiProducts, rawItems } from '../db/schema.js';
import { extractProductMergeKeys } from './product-keys.js';
import type { ProductMergeKeys } from './product-keys.js';
import { defaultLogError, type LogError } from './types.js';

type DbLike = typeof defaultDb;
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/** 塌缩所需的最小 product raw_item 视图。 */
export interface ProductRawItem {
  /** raw_items.id（BIGINT），作 representative_raw_item_id。 */
  id: bigint;
  /** 原始 title（NOT NULL）：即 PH 产品名，作 ai_products.name 来源。 */
  title: string;
  /** 原始 url（产品官网，提 canonical_domain / github_repo 的来源）。 */
  url?: string | null;
  /** raw_items.metadata（PH 原始 payload，含 product_hunt_slug / website 等）。 */
  metadata?: Record<string, unknown> | null;
}

/** 单条产品塌缩的终态。 */
export type ProductCollapseStatus = 'inserted' | 'updated' | 'merge_conflict';

export interface ProductCollapseOutcome {
  rawItemId: bigint;
  status: ProductCollapseStatus;
  /** INSERT/UPDATE 命中或新建的 product_id；冲突分支为涉及的全部 product_id（升序）。 */
  productIds: string[];
  /** 本条塌缩用到的非空归一化键（供可观测）。 */
  keys: ProductMergeKeys;
}

/**
 * 三个硬合并归一化键 `ProductMergeKeys` 与提键纯函数 `extractProductMergeKeys`
 * （含 `normalizeGithubRepo` / `extractCanonicalDomain` / F1 github.com 抑制）现迁入叶子纯模块
 * `product-keys.ts`（design D7：避免纯采集器经 product-collapse 传递拉入 PG 连接池）。本文件直接 import 复用。
 */

/**
 * name 兜底链的终极占位（零信息产品名）。单一事实来源：
 * resolveName 写入端与产品中文化候选排除端共用此常量，防字面漂移
 * （零信息输入会诱发 LLM 幻觉译名，故中文化候选据此排除占位名产品）。
 */
export const UNNAMED_PRODUCT_NAME = '(unnamed product)';

/** name 兜底链：产品名(title) → slug → canonical_domain → 终极占位（绝不留空，NOT NULL）。 */
function resolveName(item: ProductRawItem, keys: ProductMergeKeys): string {
  const title = item.title?.trim();
  if (title && title.length > 0) return title.slice(0, 255);
  if (keys.productHuntSlug) return keys.productHuntSlug.slice(0, 255);
  if (keys.canonicalDomain) return keys.canonicalDomain.slice(0, 255);
  return UNNAMED_PRODUCT_NAME;
}

/**
 * 事务内对全部非空归一键各 `SELECT ... FOR UPDATE` 收集命中 product_id 集合。
 *
 * 用单条 `WHERE (canonical_domain=? OR github_repo=? OR product_hunt_slug=?) ORDER BY
 * product_id FOR UPDATE`——`ORDER BY product_id` 使行锁按 product_id 升序获取（确定性全序，
 * 防两并发塌缩按不同键顺序加锁互相死锁，design D4）。仅把非空键纳入 OR 条件（NULL 键不参与）。
 *
 * @returns 命中的 product_id 升序数组（去重）。
 */
async function lockMatchingProductIds(
  tx: TxLike,
  keys: ProductMergeKeys,
): Promise<string[]> {
  const conditions: ReturnType<typeof sql>[] = [];
  if (keys.canonicalDomain !== null) {
    conditions.push(sql`${aiProducts.canonicalDomain} = ${keys.canonicalDomain}`);
  }
  if (keys.githubRepo !== null) {
    conditions.push(sql`${aiProducts.githubRepo} = ${keys.githubRepo}`);
  }
  if (keys.productHuntSlug !== null) {
    conditions.push(sql`${aiProducts.productHuntSlug} = ${keys.productHuntSlug}`);
  }
  // 全部键皆空：无键可合并，命中集合空（调用方走 INSERT，且空键不参与唯一约束）。
  if (conditions.length === 0) return [];

  const orClause = sql.join(conditions, sql` OR `);
  const rows = await tx
    .select({ productId: aiProducts.productId })
    .from(aiProducts)
    .where(orClause)
    // 确定性全序加锁（product_id 升序）防死锁；FOR UPDATE 锁住命中行直到事务结束。
    .orderBy(aiProducts.productId)
    .for('update');

  // 去重（一行可能被多个键同时命中，DISTINCT 化）。已按 product_id 升序。
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.productId)) {
      seen.add(r.productId);
      ids.push(r.productId);
    }
  }
  return ids;
}

/** 在涉及各行 metadata 标记 merge_conflict + 冲突对方 product_id 集合（幂等覆盖写当前组）。 */
async function markMergeConflict(
  tx: TxLike,
  productIds: string[],
  logError: LogError,
): Promise<{ newlyFlagged: boolean }> {
  // 读各行当前 metadata.merge_conflict，判断本冲突组是否已标记过（避免每轮重复刷告警）。
  const existing = await tx
    .select({
      productId: aiProducts.productId,
      metadata: aiProducts.metadata,
    })
    .from(aiProducts)
    .where(inArray(aiProducts.productId, productIds));

  const sortedGroup = [...productIds].sort();
  // 「同冲突组已标记」判定：每行 metadata.merge_conflict.conflict_with 已等于本组其余 product_id。
  let allAlreadyFlagged = existing.length === productIds.length;
  for (const row of existing) {
    const mc = (row.metadata as { merge_conflict?: { conflict_with?: unknown } } | null)
      ?.merge_conflict;
    const others = sortedGroup.filter((id) => id !== row.productId);
    const recorded = Array.isArray(mc?.conflict_with)
      ? [...(mc!.conflict_with as unknown[])].map(String).sort()
      : null;
    if (
      recorded === null ||
      recorded.length !== others.length ||
      recorded.some((id, i) => id !== others[i])
    ) {
      allAlreadyFlagged = false;
    }
  }

  // 逐行写 metadata.merge_conflict（合并保留既有键，只覆盖 merge_conflict 子对象）。
  for (const productId of productIds) {
    const others = sortedGroup.filter((id) => id !== productId);
    const patch = JSON.stringify({
      merge_conflict: {
        conflict_with: others,
        detected_at: new Date().toISOString(),
      },
    });
    await tx
      .update(aiProducts)
      .set({
        metadata: sql`COALESCE(${aiProducts.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(aiProducts.productId, productId));
  }

  // 仅在「本冲突组首次被标记」时告警，避免每轮采集重复刷（spec：同冲突组下轮再命中只更新不重复告警）。
  if (!allAlreadyFlagged) {
    logError('产品多键命中多行合并冲突（已标记 merge_conflict，未静默择一，待 P3 跨行合并）', {
      product_ids: sortedGroup,
    });
  }
  return { newlyFlagged: !allAlreadyFlagged };
}

/** 把单条 product raw_item 标记为已塌缩（collapsed=true），不再被塌缩入口扫到（幂等标记）。 */
async function markRawItemCollapsed(dbh: TxLike, rawItemId: bigint): Promise<void> {
  await dbh
    .update(rawItems)
    .set({ collapsed: true })
    .where(eq(rawItems.id, rawItemId));
}

/**
 * 塌缩单条 product raw_item 进 ai_products（事务内）。
 *
 * 流程（design D4）：
 * 1. 提三个非空归一化键。
 * 2. 事务内对全部非空键各 FOR UPDATE 收集命中 product_id 集合（按 product_id 升序加锁防死锁）。
 * 3. size=0 → INSERT（必填 name，三键与回指）；size=1 → UPDATE（累加 last_seen、记回指，不覆盖
 *    product_id）；size>1 → 标 merge_conflict + 告警（不静默择一）。
 * 4. 终态后置 raw_item.collapsed=true（与「塌缩 + 标记」同事务原子提交，崩溃重做仍正确）。
 */
export async function collapseProductRawItem(
  item: ProductRawItem,
  dbh: DbLike = defaultDb,
  logError: LogError = defaultLogError,
): Promise<ProductCollapseOutcome> {
  const keys = extractProductMergeKeys(item);
  const now = new Date();

  return dbh.transaction(async (tx) => {
    const matched = await lockMatchingProductIds(tx, keys);

    let outcome: ProductCollapseOutcome;

    if (matched.length === 0) {
      // size=0 → INSERT 新行。INSERT 必填 name（取 title，缺失兜底 slug/domain，绝不留空）。
      // 空键写 NULL（不参与唯一约束）；representative_raw_item_id 回指本 raw_item。
      const inserted = await tx
        .insert(aiProducts)
        .values({
          // product_id 省略 → DB 默认 gen_random_uuid()::text 生成不透明身份（design D4）。
          name: resolveName(item, keys),
          canonicalDomain: keys.canonicalDomain,
          githubRepo: keys.githubRepo,
          productHuntSlug: keys.productHuntSlug,
          firstSeenAt: now,
          lastSeenAt: now,
          representativeRawItemId: item.id,
        })
        .returning({ productId: aiProducts.productId });
      outcome = {
        rawItemId: item.id,
        status: 'inserted',
        productIds: [inserted[0]!.productId],
        keys,
      };
    } else if (matched.length === 1) {
      // size=1 → UPDATE：只累加 last_seen 类、记回指；**禁止覆盖 product_id**（不写 productId）。
      const productId = matched[0]!;
      await tx
        .update(aiProducts)
        .set({
          lastSeenAt: now,
          representativeRawItemId: item.id,
          updatedAt: now,
        })
        .where(eq(aiProducts.productId, productId));
      outcome = {
        rawItemId: item.id,
        status: 'updated',
        productIds: [productId],
        keys,
      };
    } else {
      // size>1 → 多键命中多行冲突：标 merge_conflict + 告警，不静默择一 upsert、不留孤儿行。
      await markMergeConflict(tx, matched, logError);
      outcome = {
        rawItemId: item.id,
        status: 'merge_conflict',
        productIds: matched,
        keys,
      };
    }

    // 终态后置 raw_item.collapsed=true（与塌缩同事务原子提交，避免每轮无界重塌）。
    await markRawItemCollapsed(tx, item.id);
    return outcome;
  });
}

/**
 * 产品塌缩入口：扫库内**所有** `raw_type='product' AND collapsed=false` 的 raw_items 逐条塌缩。
 *
 * 顺序处理（塌缩依赖唯一键冲突 / FOR UPDATE 语义，顺序执行避免同批自冲突竞态；产品塌缩由单实例承载）。
 * 每条塌缩后置 collapsed=true（见 collapseProductRawItem），故不被每轮无界重读重塌。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function collapseUncollapsedProductRawItems(
  dbh: DbLike = defaultDb,
  logError: LogError = defaultLogError,
): Promise<ProductCollapseOutcome[]> {
  const pending = await dbh
    .select({
      id: rawItems.id,
      title: rawItems.title,
      url: rawItems.url,
      metadata: rawItems.metadata,
    })
    .from(rawItems)
    .where(and(eq(rawItems.rawType, 'product'), eq(rawItems.collapsed, false)))
    .orderBy(rawItems.id);

  const outcomes: ProductCollapseOutcome[] = [];
  for (const r of pending) {
    outcomes.push(
      await collapseProductRawItem(
        {
          id: r.id,
          title: r.title,
          url: r.url,
          metadata: r.metadata as Record<string, unknown> | null,
        },
        dbh,
        logError,
      ),
    );
  }
  return outcomes;
}
