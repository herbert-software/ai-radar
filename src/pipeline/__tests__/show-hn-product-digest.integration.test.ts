/**
 * Show HN 产品发现端到端集成测试（product-discovery / source-collectors，**跑真实 Postgres**，tasks 7.4）。
 *
 * 独立 `runProductDigest` 调度已随产品合并进日报而移除；本端到端覆盖**迁移保留**为直接驱动
 * `collectAndStore`（采集+入库段）+ `collapseUncollapsedProductRawItems`（产品塌缩段），断言 Show HN
 * 产品经
 *   `collectAllSources → storeCollectedItems → collapseUncollapsedProductRawItems`
 * 全链入 `ai_products`——保留「Show HN 真被产品源采集入库 + 塌缩入 ai_products」覆盖（不随删
 * `runProductDigest` 丢失）。
 *
 * **迁移落点（钉死）**：用 `collectAndStore` 的 **per-source 选项对象 stub**（`{ productHunt:{fetchGraphql},
 * showHn:{fetchJson,...}, dbh }`，入参 `CollectAllOptions & { dbh }`、**无 channels 字段**）驱动**真实**
 * `collectShowHn`/`collectProductHunt` + stub fetch（保留 `raw_items.source='show_hn'` / github_repo 抑制
 * canonical_domain 等真实 collector 行为），再调 `collapseUncollapsedProductRawItems(db)` 塌缩——
 * **不**改成 `collectors:{}` 函数注入（那会绕过真实 collector、削弱端到端覆盖）。
 *
 * **不触发推送/锁**（遵 memory test-no-prod-sends）：本套件只跑采集 + 塌缩段，不调任何 dispatch/sender。
 * 注入 fetch 桩不触网。缺 DATABASE_URL 时本套件自动跳过；唯一前缀隔离，afterAll 清理。
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

const { collectAndStore } = await import('../../collectors/index.js');
const { collapseUncollapsedProductRawItems } = await import(
  '../../collectors/product-collapse.js'
);

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = `she2e-${process.pid}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const NOW = new Date('2099-04-01T04:00:00Z'); // 远离真实运行日的专属时刻。

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM raw_items WHERE source_item_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE product_hunt_slug LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE canonical_domain LIKE $1`, [`%${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE github_repo LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('Show HN 端到端：collectAndStore 采集入库 → collapseUncollapsedProductRawItems 入 ai_products', () => {
  it('注入 PH + Show HN fetch 桩 → Show HN 产品全链入库（不触发推送）', async () => {
    // Show HN fetch 桩：返回一条真实形状的 Algolia hit（github repo + 有 points）。
    const shObjectId = `${PREFIX}-sh-1`;
    const shRepo = `${PREFIX}-showhn/tool`;
    const showHnFetchJson = async () => ({
      hits: [
        {
          objectID: shObjectId,
          title: 'Show HN: My Show HN Tool',
          url: `https://github.com/${PREFIX}-showhn/tool`,
          created_at_i: Math.floor(NOW.getTime() / 1000) - 3600, // 窗内（1 小时前）。
          points: 99,
          num_comments: 5,
          author: 'shdev',
        },
      ],
    });

    // PH fetch 桩：返回一条 PH post（独立产品，验证两源同链采集）。
    const phSlug = `${PREFIX}-ph-1`;
    const phFetchGraphql = async () => ({
      body: {
        data: {
          posts: {
            edges: [
              {
                node: {
                  slug: phSlug,
                  name: 'PH Product',
                  website: `https://${PREFIX}-ph.example.com`,
                  url: `https://www.producthunt.com/posts/${phSlug}`,
                  votesCount: 10,
                },
              },
            ],
          },
        },
      },
      rateLimitRemaining: 5000,
      rateLimitResetSeconds: null,
    });

    // 采集 + 入库（per-source 选项 stub 在顶层，因 CollectAllOptions extends PerSourceOptions；
    // 经 buildRegistry 透传、驱动真实 collectShowHn/collectProductHunt + stub fetch）。
    // **无 channels 字段**——collectAndStore 入参是 CollectAllOptions & { dbh }，不接受 channels。
    //
    // collectAndStore 跑**全集**源；本端到端只关心产品两源，故把**非产品源的 fetch 桩**置空
    // （各自 per-source 选项的 fetch 注入点）避免真实网络/env feed 访问、不污染断言——仍是「真实
    //  collector + stub fetch」（非 collectors:{} 函数注入，符合迁移落点）。
    const emptyFeed = async () => ({ items: [] });
    const emptyJson = async () => ({});
    const emptyText = async () => '';
    const collected = await collectAndStore({
      logError: () => {},
      dbh: db!,
      // 非产品源 fetch 桩置空（真实 collector + 空 fetch，不触网）。
      rss: { fetchFeed: emptyFeed },
      hackerNews: { fetchJson: emptyJson },
      github: { fetchJson: emptyJson },
      arxiv: { fetchText: emptyText },
      hfPapers: { fetchJson: emptyJson },
      sitemap: { fetchText: emptyText },
      // blogger 源（add-ai-blogger-experience-mining）：空 feed 桩，真实 collector + 空 fetch，
      // 避免真实网络/env BLOGGER_FEEDS 访问、不污染本产品端到端断言。
      blogger: { fetchFeed: emptyFeed },
      // 产品两源：真实 collectProductHunt / collectShowHn + stub fetch（端到端覆盖）。
      productHunt: { fetchGraphql: phFetchGraphql },
      showHn: {
        fetchJson: showHnFetchJson,
        logError: () => {},
        now: NOW,
        // 桩 hit 在窗内、points 足够；闸由桩满足，不依赖默认 env 值。
        minPoints: 10,
        windowDays: 7,
      },
    });

    // 采集返回含 PH 1 + Show HN 1（真实新闻源在本测试库可能也返回 0；只断言两产品确被采到）。
    expect(collected.perSource.show_hn?.ok).toBe(true);
    expect(collected.perSource.product_hunt?.ok).toBe(true);

    // raw_items 确有 source='show_hn' 行落库（采集层确实经产品源采到 Show HN）。
    const { rows: rawRows } = await pool!.query<{ source: string; raw_type: string }>(
      `SELECT source, raw_type FROM raw_items WHERE source_item_id = $1`,
      [shObjectId],
    );
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]!.source).toBe('show_hn');
    expect(rawRows[0]!.raw_type).toBe('product');

    // 塌缩产品 raw_items → ai_products（链路显式闭合）。
    const outcomes = await collapseUncollapsedProductRawItems(db!);
    expect(outcomes.length).toBeGreaterThanOrEqual(2); // 至少塌缩 PH + Show HN 两条。

    // Show HN 产品经全链入 ai_products（按 github_repo 键，F1 抑制 github.com 域）。
    const { rows: shRows } = await pool!.query<{
      product_id: string;
      canonical_domain: string | null;
      github_repo: string | null;
    }>(`SELECT product_id, canonical_domain, github_repo FROM ai_products WHERE github_repo = $1`, [
      shRepo,
    ]);
    expect(shRows).toHaveLength(1);
    expect(shRows[0]!.github_repo).toBe(shRepo);
    expect(shRows[0]!.canonical_domain).toBeNull(); // F1：github.com 域被抑制。

    // PH 产品也入库（两源同链采集的对照）。
    const { rows: phRows } = await pool!.query<{ product_id: string }>(
      `SELECT product_id FROM ai_products WHERE product_hunt_slug = $1`,
      [phSlug],
    );
    expect(phRows).toHaveLength(1);
  });
});
