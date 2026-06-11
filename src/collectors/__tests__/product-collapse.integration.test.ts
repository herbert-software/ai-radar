/**
 * 确定性产品塌缩集成测试（任务 7.5，**硬合并不变量**）——需本地 Postgres（compose 起的库）。
 *
 * 验证 spec product-discovery「ai_products 硬规则产品合并」核心不变量：
 * - 同一产品经任一稳定键（slug / canonical_domain / github_repo）命中既有行 → UPDATE 单行、
 *   product_id 不变（不新建、不覆盖身份主键）。
 * - 首次 INSERT 填非空 name；产品名缺失时兜底 slug/domain（绝不因 NOT NULL 约束失败）。
 * - 多键命中多行：在各行 metadata 标记 merge_conflict + 告警、不静默择一 upsert、不留孤儿行；
 *   同冲突组下轮再命中只更新不重复告警。
 * - NULL 键不参与约束：两条都缺 github_repo 但 slug/domain 不同 → 各自独立行（不被 NULL 误并）。
 * - 合并全程无 LLM 调用（本模块不 import 任何 agent/LLM；流程纯程序 + DB 唯一约束）。
 *
 * 缺 DATABASE_URL 时本套件自动跳过；用唯一 source/slug 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const {
  collapseProductRawItem,
  collapseUncollapsedProductRawItems,
} = await import('../product-collapse.js');

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'pc-itest';
const PREFIX = `pc-itest-${process.pid}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 插入一条 product raw_item（source_item_id 唯一隔离），返回 id（bigint）。 */
async function seedProductRawItem(args: {
  sourceItemId: string;
  url: string | null;
  title: string;
  metadata: Record<string, unknown>;
}): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, raw_type, url, title, metadata)
     VALUES ($1, $2, 'product', $3, $4, $5::jsonb) RETURNING id`,
    [SOURCE, args.sourceItemId, args.url, args.title, JSON.stringify(args.metadata)],
  );
  return BigInt(rows[0]!.id);
}

async function fetchProduct(productId: string) {
  const { rows } = await pool!.query<{
    product_id: string;
    name: string;
    canonical_domain: string | null;
    github_repo: string | null;
    product_hunt_slug: string | null;
    representative_raw_item_id: string | null;
    metadata: { merge_conflict?: { conflict_with?: string[] } } | null;
  }>(`SELECT * FROM ai_products WHERE product_id = $1`, [productId]);
  return rows[0];
}

async function countProductsBySlugPrefix(prefix: string): Promise<number> {
  const { rows } = await pool!.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ai_products WHERE product_hunt_slug LIKE $1`,
    [`${prefix}%`],
  );
  return Number(rows[0]!.n);
}

async function cleanup() {
  if (!pool) return;
  // 删本套件造的 ai_products（按 slug / domain 前缀）与 raw_items（按 source）。
  await pool.query(`DELETE FROM ai_products WHERE product_hunt_slug LIKE $1`, [
    `${PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM ai_products WHERE canonical_domain LIKE $1`, [
    `%${PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM ai_products WHERE github_repo LIKE $1`, [
    `${PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('确定性产品塌缩（硬合并不变量）', () => {
  it('同一产品经 slug 命中 → 第二次 UPDATE 单行，product_id 不变（不新建/不覆盖身份）', async () => {
    const slug = `${PREFIX}-slug-stable`;
    const id1 = await seedProductRawItem({
      sourceItemId: `${slug}-1`,
      url: 'https://stable.example.com',
      title: 'Stable Product',
      metadata: { product_hunt_slug: slug, website: 'https://stable.example.com' },
    });
    const out1 = await collapseProductRawItem(
      { id: id1, title: 'Stable Product', url: 'https://stable.example.com', metadata: { product_hunt_slug: slug, website: 'https://stable.example.com' } },
      db!,
    );
    expect(out1.status).toBe('inserted');
    const productId = out1.productIds[0]!;

    // 第二次采到同 slug（不同 raw_item）→ 命中既有行 → UPDATE。
    const id2 = await seedProductRawItem({
      sourceItemId: `${slug}-2`,
      url: 'https://stable.example.com',
      title: 'Stable Product v2',
      metadata: { product_hunt_slug: slug, website: 'https://stable.example.com' },
    });
    const out2 = await collapseProductRawItem(
      { id: id2, title: 'Stable Product v2', url: 'https://stable.example.com', metadata: { product_hunt_slug: slug, website: 'https://stable.example.com' } },
      db!,
    );
    expect(out2.status).toBe('updated');
    expect(out2.productIds).toEqual([productId]); // product_id 不变。

    // ai_products 中该 slug 仅一行；representative_raw_item_id 更新为第二条。
    expect(await countProductsBySlugPrefix(`${PREFIX}-slug-stable`)).toBe(1);
    const row = await fetchProduct(productId);
    expect(row!.representative_raw_item_id).toBe(String(id2));

    // 两条 raw_item 都被置 collapsed=true（不再无界重塌）。
    const { rows } = await pool!.query<{ collapsed: boolean }>(
      `SELECT collapsed FROM raw_items WHERE id IN ($1, $2)`,
      [String(id1), String(id2)],
    );
    expect(rows.every((r) => r.collapsed)).toBe(true);
  });

  it('首次 INSERT 填非空 name；产品名缺失时兜底 slug（不因 NOT NULL 失败）', async () => {
    const slug = `${PREFIX}-noname`;
    // title 给占位空白模拟产品名缺失（采集器已兜底，但塌缩层兜底链亦须独立成立）。
    const id = await seedProductRawItem({
      sourceItemId: `${slug}-1`,
      url: 'https://noname.example.com',
      title: '   ',
      metadata: { product_hunt_slug: slug, website: 'https://noname.example.com' },
    });
    const out = await collapseProductRawItem(
      { id, title: '   ', url: 'https://noname.example.com', metadata: { product_hunt_slug: slug, website: 'https://noname.example.com' } },
      db!,
    );
    expect(out.status).toBe('inserted');
    const row = await fetchProduct(out.productIds[0]!);
    // name 非空：title 空白 → 兜底 slug。
    expect(row!.name).toBe(slug);
    expect(row!.name.length).toBeGreaterThan(0);
  });

  it('多键命中多行：标 merge_conflict + 告警、不静默择一、不留孤儿行；下轮不重复告警', async () => {
    const domain = `${PREFIX}-conflict.example.com`;
    const repo = `${PREFIX}-org/tool`;

    // 历史上各自独立建的两行：X 由 domain 建、Y 由 github_repo 建。
    const idX = await seedProductRawItem({
      sourceItemId: `${PREFIX}-conflict-x`,
      url: `https://${domain}`,
      title: 'Product X',
      metadata: { product_hunt_slug: `${PREFIX}-x`, website: `https://${domain}` },
    });
    const outX = await collapseProductRawItem(
      { id: idX, title: 'Product X', url: `https://${domain}`, metadata: { product_hunt_slug: `${PREFIX}-x`, website: `https://${domain}` } },
      db!,
    );
    const idY = await seedProductRawItem({
      sourceItemId: `${PREFIX}-conflict-y`,
      url: `https://github.com/${PREFIX}-org/Tool`,
      title: 'Product Y',
      metadata: { product_hunt_slug: `${PREFIX}-y`, website: `https://github.com/${PREFIX}-org/Tool` },
    });
    const outY = await collapseProductRawItem(
      { id: idY, title: 'Product Y', url: `https://github.com/${PREFIX}-org/Tool`, metadata: { product_hunt_slug: `${PREFIX}-y`, website: `https://github.com/${PREFIX}-org/Tool` } },
      db!,
    );
    const pidX = outX.productIds[0]!;
    const pidY = outY.productIds[0]!;
    expect(pidX).not.toBe(pidY);

    // 新条同时带 domain(=X) + github_repo(=Y) → 命中多行 → 冲突分支。
    const idZ = await seedProductRawItem({
      sourceItemId: `${PREFIX}-conflict-z`,
      url: `https://${domain}`,
      title: 'Product Z (both keys)',
      metadata: {
        product_hunt_slug: `${PREFIX}-z`,
        website: `https://${domain}`,
        github_repo: repo,
      },
    });
    const logged: unknown[] = [];
    const outZ = await collapseProductRawItem(
      {
        id: idZ,
        title: 'Product Z (both keys)',
        url: `https://${domain}`,
        metadata: { product_hunt_slug: `${PREFIX}-z`, website: `https://${domain}`, github_repo: repo },
      },
      db!,
      (m) => logged.push(m),
    );
    expect(outZ.status).toBe('merge_conflict');
    expect(outZ.productIds.sort()).toEqual([pidX, pidY].sort());
    // 首次冲突告警一次。
    expect(logged.length).toBe(1);

    // 各行 metadata 标 merge_conflict（互指对方 product_id）；不静默择一、不留孤儿行（两行都还在）。
    const rowX = await fetchProduct(pidX);
    const rowY = await fetchProduct(pidY);
    expect(rowX!.metadata?.merge_conflict?.conflict_with).toEqual([pidY]);
    expect(rowY!.metadata?.merge_conflict?.conflict_with).toEqual([pidX]);

    // 下轮同冲突组再命中：只更新标记不重复告警。
    const idZ2 = await seedProductRawItem({
      sourceItemId: `${PREFIX}-conflict-z2`,
      url: `https://${domain}`,
      title: 'Z again',
      metadata: { product_hunt_slug: `${PREFIX}-z2`, website: `https://${domain}`, github_repo: repo },
    });
    const logged2: unknown[] = [];
    const outZ2 = await collapseProductRawItem(
      {
        id: idZ2,
        title: 'Z again',
        url: `https://${domain}`,
        metadata: { product_hunt_slug: `${PREFIX}-z2`, website: `https://${domain}`, github_repo: repo },
      },
      db!,
      (m) => logged2.push(m),
    );
    expect(outZ2.status).toBe('merge_conflict');
    // 同冲突组不重复刷告警。
    expect(logged2.length).toBe(0);
  });

  it('NULL 键不参与约束：两条缺 github_repo 但 slug/domain 不同 → 各自独立行（不被 NULL 误并）', async () => {
    const slugA = `${PREFIX}-nullkey-a`;
    const slugB = `${PREFIX}-nullkey-b`;
    const idA = await seedProductRawItem({
      sourceItemId: `${slugA}-1`,
      url: `https://${PREFIX}-a.example.com`,
      title: 'Null Key A',
      metadata: { product_hunt_slug: slugA, website: `https://${PREFIX}-a.example.com` },
    });
    const outA = await collapseProductRawItem(
      { id: idA, title: 'Null Key A', url: `https://${PREFIX}-a.example.com`, metadata: { product_hunt_slug: slugA, website: `https://${PREFIX}-a.example.com` } },
      db!,
    );
    const idB = await seedProductRawItem({
      sourceItemId: `${slugB}-1`,
      url: `https://${PREFIX}-b.example.com`,
      title: 'Null Key B',
      metadata: { product_hunt_slug: slugB, website: `https://${PREFIX}-b.example.com` },
    });
    const outB = await collapseProductRawItem(
      { id: idB, title: 'Null Key B', url: `https://${PREFIX}-b.example.com`, metadata: { product_hunt_slug: slugB, website: `https://${PREFIX}-b.example.com` } },
      db!,
    );
    // 两条都没有 github_repo（NULL），但 slug/domain 不同 → 两条独立 INSERT，互不合并。
    expect(outA.status).toBe('inserted');
    expect(outB.status).toBe('inserted');
    expect(outA.productIds[0]).not.toBe(outB.productIds[0]);

    const rowA = await fetchProduct(outA.productIds[0]!);
    const rowB = await fetchProduct(outB.productIds[0]!);
    expect(rowA!.github_repo).toBeNull();
    expect(rowB!.github_repo).toBeNull();
  });

  it('入口 collapseUncollapsedProductRawItems：只扫 collapsed=false 的 product 行，塌缩后不再重扫', async () => {
    const slug = `${PREFIX}-entry`;
    await seedProductRawItem({
      sourceItemId: `${slug}-1`,
      url: `https://${PREFIX}-entry.example.com`,
      title: 'Entry Product',
      metadata: { product_hunt_slug: slug, website: `https://${PREFIX}-entry.example.com` },
    });
    const first = await collapseUncollapsedProductRawItems(db!, () => {});
    const mine = first.filter((o) => o.keys.productHuntSlug === slug);
    expect(mine.length).toBe(1);
    expect(mine[0]!.status).toBe('inserted');

    // 再跑一次入口：该行已 collapsed=true，不再被扫到（mine 为空）。
    const second = await collapseUncollapsedProductRawItems(db!, () => {});
    expect(second.filter((o) => o.keys.productHuntSlug === slug).length).toBe(0);
  });
});
