/**
 * 产品候选查询集成测试（merge-products-into-daily-digest，product-discovery 不变量，tasks 7.4）。
 *
 * 产品发现已合并进日报链：独立 BullMQ 调度/队列/cron/单例锁/`runProductDigest` 已移除，故本套件
 * 不再驱动独立调度，改为对**保留的导出纯查询函数** `selectProductCandidates(channel, dbh)` 做直查测试
 * （推送状态机/双段幂等由 `src/push/__tests__/daily-dispatch.integration.test.ts` 覆盖）。
 *
 * 覆盖（spec product-discovery，candidate query 口径不变）：
 * - 链接来源映射：canonical_domain → canonicalUrl='https://<domain>'；为 NULL / 畸形（含 scheme/空白）
 *   → canonicalUrl=null（渲染回退纯产品名，绝不渲染坏链接）。
 * - 跨天「从未以该 channel success」：曾在该 channel success（任一 push_date）的产品被排除（不重推）。
 * - 按 channel 分判：telegram 已 success 不抑制 feishu 候选（同一产品可分别进两通道）。
 * - merge_conflict 产品排除出候选（直到 P3 跨行合并解决）。
 * - 与事件日报 target_type 互不挤占：event 已 success 不抑制 product 候选。
 *
 * 缺 DATABASE_URL 时本套件自动跳过；唯一 product_id 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

// 注入占位 env 让无真实凭据也能 import config/env（启动期校验）；DATABASE_URL 仍由 .env/CI 注入。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { selectProductCandidates } = await import('../product-digest.js');

const databaseUrl = process.env.DATABASE_URL;
const canRun = Boolean(databaseUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const PREFIX = `pd-itest-${process.pid}-`;
const PUSH_DATE_1 = '2099-03-01';

/** 插一条 ai_products，返回 product_id（用前缀 + 显式 product_id 隔离）。 */
async function seedProduct(args: {
  suffix: string;
  name?: string;
  canonicalDomain?: string | null;
  githubRepo?: string | null;
  productHuntSlug?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<string> {
  const productId = `${PREFIX}${args.suffix}`;
  await pool!.query(
    `INSERT INTO ai_products
       (product_id, name, canonical_domain, github_repo, product_hunt_slug, last_seen_at, metadata)
     VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb)`,
    [
      productId,
      args.name ?? `${PREFIX}${args.suffix}-name`,
      args.canonicalDomain ?? null,
      args.githubRepo ?? null,
      args.productHuntSlug ?? null,
      args.metadata ? JSON.stringify(args.metadata) : null,
    ],
  );
  return productId;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE product_id LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!canRun)('selectProductCandidates 候选查询（productDiscovery，7.4）', () => {
  it('链接映射：canonical_domain → canonicalUrl=https://<domain>', async () => {
    const pid = await seedProduct({ suffix: 'url-ok', canonicalDomain: 'tool.example.com' });
    const candidates = await selectProductCandidates('telegram', db!);
    const c = candidates.find((x) => x.eventId === pid)!;
    expect(c).toBeTruthy();
    expect(c.canonicalUrl).toBe('https://tool.example.com');
    // 候选视图：eventId=product_id、标题=产品名、headline/summary 恒 null（零 LLM）。
    expect(c.headlineZh).toBeNull();
    expect(c.summaryZh).toBeNull();
  });

  it('链接映射：canonical_domain 为 NULL → canonicalUrl=null（降级纯产品名）', async () => {
    const pid = await seedProduct({ suffix: 'url-null', canonicalDomain: null });
    const candidates = await selectProductCandidates('telegram', db!);
    const c = candidates.find((x) => x.eventId === pid)!;
    expect(c.canonicalUrl).toBeNull();
  });

  it('链接映射：canonical_domain 畸形（含 scheme/空白）→ canonicalUrl=null（不产生 https://https://…）', async () => {
    // product-collapse 写入端规范化为裸域；若历史/异常数据含 scheme 或空白，映射须降级 null 防坏链接。
    const pidScheme = await seedProduct({ suffix: 'url-scheme', canonicalDomain: 'https://evil.example.com' });
    const pidSpace = await seedProduct({ suffix: 'url-space', canonicalDomain: 'has space.com' });
    const candidates = await selectProductCandidates('telegram', db!);
    expect(candidates.find((x) => x.eventId === pidScheme)!.canonicalUrl).toBeNull();
    expect(candidates.find((x) => x.eventId === pidSpace)!.canonicalUrl).toBeNull();
  });

  it('链接映射：canonical_domain 带端口（host:port）→ canonicalUrl 保留（合法带端口域不被误杀）', async () => {
    // extractCanonicalDomain 用 new URL(url).host 提取，host 合法可含端口；带端口域须保留链接。
    const pid = await seedProduct({ suffix: 'url-port', canonicalDomain: 'example.com:8080' });
    const candidates = await selectProductCandidates('telegram', db!);
    expect(candidates.find((x) => x.eventId === pid)!.canonicalUrl).toBe('https://example.com:8080');
  });

  it('回退链 ②：canonical_domain=NULL + github_repo → canonicalUrl=https://github.com/owner/repo', async () => {
    // 生产实锤 themartiano/luz：纯 GitHub 仓库类产品（canonical_domain 空、仅 github_repo），
    // 候选经 resolveProductUrl 回退产出 github 链接（不再因 canonical_domain 空而丢链接）。
    const pid = await seedProduct({
      suffix: 'gh-repo',
      canonicalDomain: null,
      githubRepo: `${PREFIX}owner/repo`,
    });
    const candidates = await selectProductCandidates('telegram', db!);
    const c = candidates.find((x) => x.eventId === pid)!;
    expect(c.canonicalUrl).toBe(`https://github.com/${PREFIX}owner/repo`);
    // 候选携带存储三键（供跨段去重对齐从内存读、不回查 DB）。
    expect(c.productMergeKeys).toEqual({
      canonicalDomain: null,
      githubRepo: `${PREFIX}owner/repo`,
      productHuntSlug: null,
    });
  });

  it('回退链 ③：仅 product_hunt_slug → canonicalUrl=https://www.producthunt.com/posts/<slug>', async () => {
    const slug = `${PREFIX}foo`;
    const pid = await seedProduct({
      suffix: 'ph-slug',
      canonicalDomain: null,
      githubRepo: null,
      productHuntSlug: slug,
    });
    const candidates = await selectProductCandidates('telegram', db!);
    const c = candidates.find((x) => x.eventId === pid)!;
    expect(c.canonicalUrl).toBe(`https://www.producthunt.com/posts/${slug}`);
    expect(c.productMergeKeys).toEqual({
      canonicalDomain: null,
      githubRepo: null,
      productHuntSlug: slug,
    });
  });

  it('跨天「从未以该 channel success」：曾在该 channel success 的产品被排除（不重推）', async () => {
    const pid = await seedProduct({ suffix: 'cross-day' });
    // 任一 push_date 的该 channel success 即排除（跨天一生一次）。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('product', $1, 'telegram', $2, 'success', now())`,
      [pid, PUSH_DATE_1],
    );
    const candidates = await selectProductCandidates('telegram', db!);
    expect(candidates.map((c) => c.eventId)).not.toContain(pid);
  });

  it('按 channel 分判：telegram 已 success 不抑制 feishu 候选（同一产品可分别进两通道）', async () => {
    const pid = await seedProduct({ suffix: 'per-channel' });
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('product', $1, 'telegram', $2, 'success', now())`,
      [pid, PUSH_DATE_1],
    );
    // telegram 已 success → telegram 候选排除它。
    const tg = await selectProductCandidates('telegram', db!);
    expect(tg.map((c) => c.eventId)).not.toContain(pid);
    // feishu 从未 success → feishu 候选仍含它（按 channel 分判，不被 telegram 抑制）。
    const fs = await selectProductCandidates('feishu', db!);
    expect(fs.map((c) => c.eventId)).toContain(pid);
  });

  it('merge_conflict 产品排除出候选（干净产品仍入候选）', async () => {
    const pidX = await seedProduct({
      suffix: 'conflict-x',
      metadata: { merge_conflict: { conflict_with: [`${PREFIX}conflict-y`], detected_at: 'now' } },
    });
    const pidY = await seedProduct({
      suffix: 'conflict-y',
      metadata: { merge_conflict: { conflict_with: [`${PREFIX}conflict-x`], detected_at: 'now' } },
    });
    const pidClean = await seedProduct({ suffix: 'conflict-clean' });

    const candidates = await selectProductCandidates('telegram', db!);
    const ids = candidates.map((c) => c.eventId);
    expect(ids).not.toContain(pidX);
    expect(ids).not.toContain(pidY);
    expect(ids).toContain(pidClean);
  });

  it('与事件日报 target_type 互不挤占：event 已 success 不抑制 product 候选', async () => {
    const sharedId = `${PREFIX}shared-target`;
    await seedProduct({ suffix: 'shared-target' });
    // 以 target_type='event' 在 telegram 写一条 success（模拟事件日报已推同名 id）。
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('event', $1, 'telegram', $2, 'success', now())`,
      [sharedId, PUSH_DATE_1],
    );
    // 产品候选不被 event 的 success 抑制（target_type 不同各自独立命名空间）。
    const candidates = await selectProductCandidates('telegram', db!);
    expect(candidates.map((c) => c.eventId)).toContain(sharedId);
  });
});
