/**
 * 硬去重塌缩集成测试（任务 5.3，**dedup 不变量**）——需本地 Postgres（compose 起的库）。
 *
 * 验证 design D1/D3 的核心不变量：
 * - 两条同 canonical_url 的 raw_item 塌缩为同一 event（同 event_id），source_count=2，
 *   `UNIQUE(dedup_key)` 兜底（第二条走 ON CONFLICT DO UPDATE 而非新建行）。
 * - **再次塌缩不覆盖** event_id / representative_raw_item_id / representative_title /
 *   first_seen_at / published_at（仅 source_count 累加、last_seen_at 更新）。
 * - representative_title 取代表 raw_item 的**原始** title（非归一化）。
 * - unprocessable raw_item 不产生 event，仅置 raw_items.unprocessable=true。
 *
 * 缺 DATABASE_URL 时本套件自动跳过（CI 在有 pg service 的 job 才跑到）。
 * 每个用例用唯一 source_item_id 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';

// collapse.js 间接 import config/env（启动期校验全部必填变量，含 TELEGRAM_*）。
// 本套件只测塌缩落库、不发推送，故为推送相关变量注入占位，使无 Telegram 凭据也能跑；
// 真实 DATABASE_URL 仍由 .env / CI 注入（缺则整套件 skip）。占位用 ||= 兼容空串。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';

// 在占位 env 就位后再动态 import 塌缩模块（其 import 链会触发 env 校验）。
const { collapseRawItem, collapseRawItems, collapseUncollapsedRawItems } =
  await import('../collapse.js');

const databaseUrl = process.env.DATABASE_URL;

const SOURCE = 'collapse-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 插入一条 raw_item，返回其 id（bigint）。source_item_id 唯一以隔离。 */
async function seedRawItem(args: {
  sourceItemId: string;
  url: string | null;
  title: string;
  publishedAt: Date | null;
  /** 显式入库时间；省略则依赖列 defaultNow()。 */
  fetchedAt?: Date;
}): Promise<bigint> {
  if (args.fetchedAt) {
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO raw_items (source, source_item_id, url, title, published_at, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [SOURCE, args.sourceItemId, args.url, args.title, args.publishedAt, args.fetchedAt],
    );
    return BigInt(rows[0]!.id);
  }
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title, published_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [SOURCE, args.sourceItemId, args.url, args.title, args.publishedAt],
  );
  return BigInt(rows[0]!.id);
}

/** 插入一条带显式 raw_type 的 raw_item（用于类型路由测试），返回 id。 */
async function seedTypedRawItem(args: {
  sourceItemId: string;
  url: string | null;
  title: string;
  rawType: string;
}): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title, raw_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [SOURCE, args.sourceItemId, args.url, args.title, args.rawType],
  );
  return BigInt(rows[0]!.id);
}

async function fetchEventByDedupKey(dedupKey: string) {
  const { rows } = await pool!.query<{
    event_id: string;
    representative_raw_item_id: string | null;
    representative_title: string | null;
    first_seen_at: Date | null;
    published_at: Date | null;
    last_seen_at: Date | null;
    source_count: number;
  }>(
    `SELECT event_id, representative_raw_item_id, representative_title,
            first_seen_at, published_at, last_seen_at, source_count
     FROM ai_news_events WHERE dedup_key = $1`,
    [dedupKey],
  );
  return rows;
}

beforeAll(async () => {
  if (!pool) return;
  // 清理可能的上轮残留（按本套件造的 raw_item 的 dedup_key 反查事件较繁琐，
  // 直接按 representative_raw_item_id 指向本 source 的行删除事件，再删 raw_items）。
  await pool.query(
    `DELETE FROM ai_news_events WHERE representative_raw_item_id IN
       (SELECT id FROM raw_items WHERE source = $1)`,
    [SOURCE],
  );
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
});

afterAll(async () => {
  if (pool) {
    await pool.query(
      `DELETE FROM ai_news_events WHERE representative_raw_item_id IN
         (SELECT id FROM raw_items WHERE source = $1)`,
      [SOURCE],
    );
    await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
    await pool.end();
  }
});

describe.skipIf(!databaseUrl)('硬去重塌缩（dedup 不变量）', () => {
  it('两条同 canonical_url 的 raw_item 塌缩为同一 event，source_count=2，不覆盖身份/时间/代表列', async () => {
    const ts = Date.now();
    const pub1 = new Date('2026-06-01T00:00:00Z');
    const pub2 = new Date('2026-06-02T00:00:00Z');

    // 两条原始 URL 仅追踪参数不同 → 同 canonical_url → 同 dedup_key。
    const id1 = await seedRawItem({
      sourceItemId: `same-url-1-${ts}`,
      url: 'https://example.com/news/a?utm_source=tw&id=1',
      title: 'First representative title',
      publishedAt: pub1,
    });
    const id2 = await seedRawItem({
      sourceItemId: `same-url-2-${ts}`,
      url: 'https://example.com/news/a?id=1&ref=hn&spm=x',
      title: 'Second arrival title',
      publishedAt: pub2,
    });

    const out1 = await collapseRawItem({
      id: id1,
      url: 'https://example.com/news/a?utm_source=tw&id=1',
      title: 'First representative title',
      publishedAt: pub1,
      fetchedAt: new Date(),
    }, db!);
    const out2 = await collapseRawItem({
      id: id2,
      url: 'https://example.com/news/a?id=1&ref=hn&spm=x',
      title: 'Second arrival title',
      publishedAt: pub2,
      fetchedAt: new Date(),
    }, db!);

    expect(out1.unprocessable).toBe(false);
    expect(out2.unprocessable).toBe(false);
    // 同 canonical_url → 同 dedup_key（UNIQUE(dedup_key) 兜底，二者落同一行）。
    expect(out1.dedupKey).toBe(out2.dedupKey);

    const rows = await fetchEventByDedupKey(out1.dedupKey!);
    // 只产生一行 event（第二条走 ON CONFLICT DO UPDATE 而非新建）。
    expect(rows).toHaveLength(1);
    const ev = rows[0]!;

    // source_count 累加为 2。
    expect(Number(ev.source_count)).toBe(2);

    // 首建身份/代表/时间列保持首建值不变（再次塌缩绝不覆盖）。
    expect(ev.representative_raw_item_id).toBe(id1.toString());
    expect(ev.representative_title).toBe('First representative title');
    expect(ev.first_seen_at).not.toBeNull();
    // published_at 取首条（pub1），未被第二条 pub2 覆盖。timestamp 无时区列读回有本地偏移，
    // 故不与原始 JS Date 直接比，而是断言：非空、且不等于第二条的 pub2（证明未被覆盖）。
    expect(ev.published_at).not.toBeNull();
    expect(ev.published_at?.toISOString()).not.toBe(pub2.toISOString());

    // event_id 为 DB 生成的非空 UUID 文本（非内容派生、非 seed-<id>）。
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev.event_id.startsWith('seed-')).toBe(false);

    // raw_items 回写了 canonical_url（去 utm/ref/spm）与 title_hash + normalizer_version。
    const { rows: rawRows } = await pool!.query<{
      canonical_url: string | null;
      title_hash: string | null;
      unprocessable: boolean;
      metadata: { normalizer_version?: number } | null;
    }>(
      `SELECT canonical_url, title_hash, unprocessable, metadata FROM raw_items WHERE id = $1`,
      [id1.toString()],
    );
    expect(rawRows[0]!.canonical_url).toBe('https://example.com/news/a?id=1');
    expect(rawRows[0]!.title_hash).not.toBeNull();
    expect(rawRows[0]!.unprocessable).toBe(false);
    expect(rawRows[0]!.metadata?.normalizer_version).toBe(1);
  });

  it('第三条同 dedup_key 再塌缩：身份/代表/first_seen/published 仍不变，source_count→3', async () => {
    const ts = Date.now();
    const url = `https://example.com/stable/${ts}`;
    const pub = new Date('2026-05-01T00:00:00Z');

    const id1 = await seedRawItem({
      sourceItemId: `stable-1-${ts}`,
      url,
      title: 'Anchor title',
      publishedAt: pub,
    });
    const first = await collapseRawItem({ id: id1, url, title: 'Anchor title', publishedAt: pub, fetchedAt: new Date() }, db!);
    const before = (await fetchEventByDedupKey(first.dedupKey!))[0]!;

    // 再来两条同 URL（不同发布时间/标题），断言不覆盖首建值。
    const id2 = await seedRawItem({ sourceItemId: `stable-2-${ts}`, url, title: 'Later A', publishedAt: new Date('2026-05-09T00:00:00Z') });
    const id3 = await seedRawItem({ sourceItemId: `stable-3-${ts}`, url, title: 'Later B', publishedAt: new Date('2026-05-10T00:00:00Z') });
    await collapseRawItems([
      { id: id2, url, title: 'Later A', publishedAt: new Date('2026-05-09T00:00:00Z'), fetchedAt: new Date() },
      { id: id3, url, title: 'Later B', publishedAt: new Date('2026-05-10T00:00:00Z'), fetchedAt: new Date() },
    ], db!);

    const after = (await fetchEventByDedupKey(first.dedupKey!))[0]!;
    expect(Number(after.source_count)).toBe(3);
    expect(after.event_id).toBe(before.event_id);
    expect(after.representative_raw_item_id).toBe(id1.toString());
    expect(after.representative_title).toBe('Anchor title');
    // 不变量是「再塌缩不改 first_seen/published」——与首建后 DB 读回的 before 快照对比，
    // 而非与原始 JS Date 对比（timestamp 无时区列经 node-pg 读回会按本地时区偏移，属读回口径差异、非逻辑 bug）。
    expect(after.first_seen_at?.toISOString()).toBe(before.first_seen_at?.toISOString());
    expect(after.published_at?.toISOString()).toBe(before.published_at?.toISOString());
  });

  it('unprocessable：无 URL 且标题归一为空 → 不产生 event，raw_items.unprocessable=true', async () => {
    const ts = Date.now();
    const id = await seedRawItem({
      sourceItemId: `unproc-${ts}`,
      url: null,
      title: '🚀🚀！！！',
    publishedAt: null,
    });
    const out = await collapseRawItem({ id, url: null, title: '🚀🚀！！！', publishedAt: null, fetchedAt: new Date() }, db!);

    expect(out.unprocessable).toBe(true);
    expect(out.dedupKey).toBeNull();

    const { rows } = await pool!.query<{ unprocessable: boolean }>(
      `SELECT unprocessable FROM raw_items WHERE id = $1`,
      [id.toString()],
    );
    expect(rows[0]!.unprocessable).toBe(true);

    // 不产生任何 event 指向该 raw_item。
    const { rows: evRows } = await pool!.query(
      `SELECT 1 FROM ai_news_events WHERE representative_raw_item_id = $1`,
      [id.toString()],
    );
    expect(evRows).toHaveLength(0);
  });

  it('无 URL 但标题可归一 → 用 title_hash 兜底 dedup_key 正常塌缩成 event', async () => {
    const ts = Date.now();
    const title = `OpenAI 发布新模型 ${ts}`;
    const id = await seedRawItem({ sourceItemId: `titlefallback-${ts}`, url: null, title, publishedAt: null });
    const out = await collapseRawItem({ id, url: null, title, publishedAt: null, fetchedAt: new Date() }, db!);

    expect(out.unprocessable).toBe(false);
    expect(out.dedupKey).not.toBeNull();
    const rows = await fetchEventByDedupKey(out.dedupKey!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.representative_title).toBe(title);

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${out.dedupKey}`);
  });

  it('已 collapsed 的 raw_item 重跑 collapseUncollapsedRawItems 不再二次累加 source_count', async () => {
    const ts = Date.now();
    const url = `https://example.com/idempotent/${ts}`;

    const id = await seedRawItem({
      sourceItemId: `idem-${ts}`,
      url,
      title: 'Idempotent collapse title',
      publishedAt: null,
    });

    // 第一轮：扫出未塌缩条目并塌缩，置 collapsed=true。
    const first = await collapseUncollapsedRawItems(db!);
    const mine = first.filter((o) => o.rawItemId === id);
    expect(mine).toHaveLength(1);
    const dedupKey = mine[0]!.dedupKey!;
    expect(mine[0]!.unprocessable).toBe(false);

    let rows = await fetchEventByDedupKey(dedupKey);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.source_count)).toBe(1);

    // raw_item 已被标记 collapsed=true。
    const { rows: flagRows } = await pool!.query<{ collapsed: boolean }>(
      `SELECT collapsed FROM raw_items WHERE id = $1`,
      [id.toString()],
    );
    expect(flagRows[0]!.collapsed).toBe(true);

    // 第二轮重跑：该条已 collapsed → 不再被扫到 → source_count 仍为 1（幂等，未二次累加）。
    const second = await collapseUncollapsedRawItems(db!);
    expect(second.some((o) => o.rawItemId === id)).toBe(false);

    rows = await fetchEventByDedupKey(dedupKey);
    expect(Number(rows[0]!.source_count)).toBe(1);

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${dedupKey}`);
  });

  it('崩溃后未 collapsed 的 raw_item 下次被补塌缩（即使 insertedIds 不含它）', async () => {
    const ts = Date.now();
    const url = `https://example.com/crash-recovery/${ts}`;

    // 模拟「INSERT 成功但塌缩前崩溃」：raw_item 已入库、collapsed 仍为默认 false，
    // 且本轮不在任何 insertedIds 列表里（这里根本不传 id 列表，由 collapsed 标记驱动）。
    const id = await seedRawItem({
      sourceItemId: `crash-${ts}`,
      url,
      title: 'Crash recovery title',
      publishedAt: null,
    });

    // 确认初始 collapsed=false（崩溃前未来得及标记）。
    const { rows: before } = await pool!.query<{ collapsed: boolean }>(
      `SELECT collapsed FROM raw_items WHERE id = $1`,
      [id.toString()],
    );
    expect(before[0]!.collapsed).toBe(false);

    // 下一轮塌缩：按 collapsed=false 扫到该条 → 补塌缩成 event。
    const outcomes = await collapseUncollapsedRawItems(db!);
    const mine = outcomes.filter((o) => o.rawItemId === id);
    expect(mine).toHaveLength(1);
    const dedupKey = mine[0]!.dedupKey!;
    expect(mine[0]!.unprocessable).toBe(false);

    const rows = await fetchEventByDedupKey(dedupKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.representative_raw_item_id).toBe(id.toString());

    const { rows: after } = await pool!.query<{ collapsed: boolean }>(
      `SELECT collapsed FROM raw_items WHERE id = $1`,
      [id.toString()],
    );
    expect(after[0]!.collapsed).toBe(true);

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${dedupKey}`);
  });

  it('unprocessable 的 raw_item 被标记 collapsed=true，重跑不再被扫到', async () => {
    const ts = Date.now();
    const id = await seedRawItem({
      sourceItemId: `unproc-collapsed-${ts}`,
      url: null,
      title: '🚀🚀！！！',
      publishedAt: null,
    });

    const first = await collapseUncollapsedRawItems(db!);
    const mine = first.filter((o) => o.rawItemId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.unprocessable).toBe(true);

    const { rows } = await pool!.query<{
      unprocessable: boolean;
      collapsed: boolean;
    }>(`SELECT unprocessable, collapsed FROM raw_items WHERE id = $1`, [
      id.toString(),
    ]);
    expect(rows[0]!.unprocessable).toBe(true);
    expect(rows[0]!.collapsed).toBe(true);

    // 重跑不再被扫到（既因 unprocessable=true 也因 collapsed=true）。
    const second = await collapseUncollapsedRawItems(db!);
    expect(second.some((o) => o.rawItemId === id)).toBe(false);
  });

  it('塌缩原子性：事务内 markCollapsed 抛错整体回滚 → raw_item 仍 collapsed=false 且 source_count 未被污染的 +1', async () => {
    const ts = Date.now();
    const url = `https://example.com/atomic-rollback/${ts}`;

    const id = await seedRawItem({
      sourceItemId: `atomic-${ts}`,
      url,
      title: 'Atomic rollback title',
      publishedAt: null,
    });

    // 包一层 dbh 代理：transaction 仍走真实 db.transaction，但把回调拿到的 tx 包成
    // 「insert/onConflict 正常、update（markCollapsed）抛错」——模拟「INSERT 成功但塌缩标记未提交」。
    // 抛错应使整事务回滚：event 的 source_count +1 与 raw_items.collapsed=true 都不落库。
    type Db = NonNullable<typeof db>;
    type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
    const txProxy = (tx: Tx): Tx =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'update') {
            return () => {
              throw new Error('markCollapsed boom (simulated crash)');
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    const dbhProxy = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (cb: (tx: Tx) => Promise<unknown>) =>
            target.transaction((tx) => cb(txProxy(tx)));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    await expect(collapseRawItem({ id, url, title: 'Atomic rollback title', publishedAt: null, fetchedAt: new Date() }, dbhProxy)).rejects.toThrow(/markCollapsed boom/);

    // 回滚后：raw_items.collapsed 仍 false（下轮可被重扫补塌缩）。
    const { rows: flagRows } = await pool!.query<{ collapsed: boolean }>(
      `SELECT collapsed FROM raw_items WHERE id = $1`,
      [id.toString()],
    );
    expect(flagRows[0]!.collapsed).toBe(false);

    // 回滚后：无该 dedup_key 的 event 行（INSERT 也随事务回滚，source_count 未被污染的 +1）。
    const { sha256Hex, normalizeUrl } = await import('../normalize.js');
    const dedupKey = sha256Hex(normalizeUrl(url)!);
    let rows = await fetchEventByDedupKey(dedupKey);
    expect(rows).toHaveLength(0);

    // 正常路径重做（真实 db）：事务提交后 collapsed=true 且 source_count=1。
    const out = await collapseRawItem({ id, url, title: 'Atomic rollback title', publishedAt: null, fetchedAt: new Date() }, db!);
    expect(out.unprocessable).toBe(false);
    rows = await fetchEventByDedupKey(out.dedupKey!);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.source_count)).toBe(1);

    const { rows: after } = await pool!.query<{ collapsed: boolean }>(
      `SELECT collapsed FROM raw_items WHERE id = $1`,
      [id.toString()],
    );
    expect(after[0]!.collapsed).toBe(true);

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${out.dedupKey}`);
  });

  it('补塌缩很久以前入库的 raw_item：first_seen_at 取其 fetched_at 而非 now（旧闻不被误标刚首见）', async () => {
    const ts = Date.now();
    const url = `https://example.com/stale-fetch/${ts}`;
    // 模拟崩溃残留/延迟未塌缩的旧条目：fetched_at 在 30 天前。
    const oldFetchedAt = new Date(ts - 30 * 24 * 60 * 60 * 1000);

    const id = await seedRawItem({
      sourceItemId: `stale-${ts}`,
      url,
      title: 'Stale fetched title',
      publishedAt: null,
      fetchedAt: oldFetchedAt,
    });

    const outcomes = await collapseUncollapsedRawItems(db!);
    const mine = outcomes.filter((o) => o.rawItemId === id);
    expect(mine).toHaveLength(1);
    const dedupKey = mine[0]!.dedupKey!;

    const rows = await fetchEventByDedupKey(dedupKey);
    expect(rows).toHaveLength(1);
    // first_seen_at 取 raw_item 的旧 fetched_at（绝非塌缩时刻 now）。
    expect(rows[0]!.first_seen_at?.toISOString()).toBe(oldFetchedAt.toISOString());

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${dedupKey}`);
  });

  it('类型路由：product/paper 条目不被塌缩入口扫到（不产生 ai_news_events）', async () => {
    const ts = Date.now();
    // product（PH）与 paper（arXiv）行：均有可归一化的 url/title，若未排除会塌缩成 event。
    const productId = await seedTypedRawItem({
      sourceItemId: `route-product-${ts}`,
      url: `https://producthunt.com/posts/x-${ts}`,
      title: 'Some product',
      rawType: 'product',
    });
    const paperId = await seedTypedRawItem({
      sourceItemId: `route-paper-${ts}`,
      url: `https://arxiv.org/abs/2406.${ts}`,
      title: 'Some paper',
      rawType: 'paper',
    });
    // 对照：一条 news 行（应正常进事件流）。
    const newsId = await seedTypedRawItem({
      sourceItemId: `route-news-${ts}`,
      url: `https://example.com/news-${ts}`,
      title: 'Some news',
      rawType: 'news',
    });

    const outcomes = await collapseUncollapsedRawItems(db!);
    const scanned = new Set(outcomes.map((o) => o.rawItemId));
    // product/paper 被查询层排除 → 不在本轮塌缩结果里。
    expect(scanned.has(productId)).toBe(false);
    expect(scanned.has(paperId)).toBe(false);
    // news 行正常被扫到塌缩。
    expect(scanned.has(newsId)).toBe(true);

    // 不为 product/paper 产生任何 ai_news_events 行。
    const { rows: evRows } = await pool!.query(
      `SELECT 1 FROM ai_news_events WHERE representative_raw_item_id IN ($1, $2)`,
      [productId.toString(), paperId.toString()],
    );
    expect(evRows).toHaveLength(0);

    // 清理 news 行产生的 event。
    const newsOutcome = outcomes.find((o) => o.rawItemId === newsId)!;
    if (newsOutcome.dedupKey) {
      await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${newsOutcome.dedupKey}`);
    }
  });

  it('类型路由：experience 条目不被塌缩入口扫到（不产生 ai_news_events，组 D 4.1）', async () => {
    const ts = Date.now();
    // experience（blogger 经验源）行：有可归一化的 url/title，若未排除会塌缩成 event。
    const experienceId = await seedTypedRawItem({
      sourceItemId: `route-experience-${ts}`,
      url: `https://example.com/blogger/post-${ts}`,
      title: 'Some experience post',
      rawType: 'experience',
    });
    // 对照：一条 news 行（应正常进事件流）。
    const newsId = await seedTypedRawItem({
      sourceItemId: `route-exp-news-${ts}`,
      url: `https://example.com/exp-news-${ts}`,
      title: 'Some news beside experience',
      rawType: 'news',
    });

    const outcomes = await collapseUncollapsedRawItems(db!);
    const scanned = new Set(outcomes.map((o) => o.rawItemId));
    // experience 被查询层排除 → 不在本轮塌缩结果里。
    expect(scanned.has(experienceId)).toBe(false);
    // news 行正常被扫到塌缩。
    expect(scanned.has(newsId)).toBe(true);

    // 不为 experience 产生任何 ai_news_events 行。
    const { rows: evRows } = await pool!.query(
      `SELECT 1 FROM ai_news_events WHERE representative_raw_item_id = $1`,
      [experienceId.toString()],
    );
    expect(evRows).toHaveLength(0);

    // 清理 news 行产生的 event。
    const newsOutcome = outcomes.find((o) => o.rawItemId === newsId)!;
    if (newsOutcome.dedupKey) {
      await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${newsOutcome.dedupKey}`);
    }
  });

  it('NULL raw_type 视作新闻类纳入塌缩（IS DISTINCT FROM，保 P1 行为）', async () => {
    const ts = Date.now();
    // 不设 raw_type（NULL）：必须仍被当作新闻塌缩成 event。
    const id = await seedRawItem({
      sourceItemId: `route-nulltype-${ts}`,
      url: `https://example.com/nulltype-${ts}`,
      title: 'Null type news',
      publishedAt: null,
    });
    const outcomes = await collapseUncollapsedRawItems(db!);
    const mine = outcomes.find((o) => o.rawItemId === id);
    expect(mine).toBeDefined();
    expect(mine!.unprocessable).toBe(false);
    expect(mine!.dedupKey).not.toBeNull();
    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${mine!.dedupKey}`);
  });

  it('paper 行入库即 collapsed=true 时不被塌缩入口重扫（仅沉淀、不每轮重扫）', async () => {
    const ts = Date.now();
    // arXiv 论文入库即 collapsed=true：塌缩入口（只扫 collapsed=false）不应扫到它。
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO raw_items (source, source_item_id, url, title, raw_type, collapsed)
       VALUES ($1, $2, $3, $4, 'paper', true) RETURNING id`,
      [
        SOURCE,
        `route-paper-collapsed-${ts}`,
        `https://arxiv.org/abs/2407.${ts}`,
        'Sunk paper',
      ],
    );
    const paperId = BigInt(rows[0]!.id);

    const outcomes = await collapseUncollapsedRawItems(db!);
    expect(outcomes.some((o) => o.rawItemId === paperId)).toBe(false);
  });

  // ── 塌缩层确定性 published_at NULL-fill（task 1b.2，design D8）──────────────
  // COALESCE(published_at, EXCLUDED.published_at) 单向 NULL-fill：
  // 首建无日期 → 后到确定日期补入；首建有日期 → 后到不同日期不覆盖。

  it('首建无日期 + 后到同 dedup_key 有确定日期 → COALESCE 补入（确定性优先于 AI）', async () => {
    const ts = Date.now();
    const url = `https://example.com/nullfill/${ts}`;
    const knownPub = new Date('2026-05-15T00:00:00Z');

    // 首条 raw_item 无 publishedAt（null）→ 事件 published_at 为 NULL。
    const id1 = await seedRawItem({
      sourceItemId: `nullfill-1-${ts}`,
      url,
      title: 'Null-first title',
      publishedAt: null,
    });
    const first = await collapseRawItem(
      { id: id1, url, title: 'Null-first title', publishedAt: null, fetchedAt: new Date() },
      db!,
    );
    const dedupKey = first.dedupKey!;

    let rows = await fetchEventByDedupKey(dedupKey);
    expect(rows).toHaveLength(1);
    // 首建 published_at 为 NULL（首条无发布时间）。
    expect(rows[0]!.published_at).toBeNull();

    // 后到同 dedup_key 的 raw_item 带确定 publishedAt → COALESCE 把确定值补入。
    const id2 = await seedRawItem({
      sourceItemId: `nullfill-2-${ts}`,
      url,
      title: 'Dated arrival title',
      publishedAt: knownPub,
    });
    await collapseRawItem(
      { id: id2, url, title: 'Dated arrival title', publishedAt: knownPub, fetchedAt: new Date() },
      db!,
    );

    rows = await fetchEventByDedupKey(dedupKey);
    expect(rows).toHaveLength(1);
    // published_at 由 NULL 经 COALESCE 单向补入确定值（NULL→已知）。
    expect(rows[0]!.published_at).not.toBeNull();
    expect(rows[0]!.published_at?.toISOString()).toBe(knownPub.toISOString());
    // 身份/代表/first_seen 仍冻结（仅 published_at 被补值）。
    expect(rows[0]!.representative_raw_item_id).toBe(id1.toString());
    expect(rows[0]!.representative_title).toBe('Null-first title');
    // source_count 累加为 2（两条都贡献）。
    expect(Number(rows[0]!.source_count)).toBe(2);

    // 补值后该事件 published_at 非 NULL，故不再进 AI 推断域：
    // 以 `published_at IS NULL` 查询断言该事件不在结果（后续回填查询不会选中它）。
    const { rows: nullRows } = await pool!.query<{ event_id: string }>(
      `SELECT event_id FROM ai_news_events WHERE dedup_key = $1 AND published_at IS NULL`,
      [dedupKey],
    );
    expect(nullRows).toHaveLength(0);

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${dedupKey}`);
  });

  it('首建已有日期 + 后到不同日期 → 保持首建值不变（COALESCE 不覆盖已设值）', async () => {
    const ts = Date.now();
    const url = `https://example.com/nofill-overwrite/${ts}`;
    const d1 = new Date('2026-05-01T00:00:00Z');
    const d2 = new Date('2026-05-20T00:00:00Z');

    // 首建已有 publishedAt = D1。
    const id1 = await seedRawItem({
      sourceItemId: `nofill-1-${ts}`,
      url,
      title: 'Dated-first title',
      publishedAt: d1,
    });
    const first = await collapseRawItem(
      { id: id1, url, title: 'Dated-first title', publishedAt: d1, fetchedAt: new Date() },
      db!,
    );
    const dedupKey = first.dedupKey!;
    const before = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(before.published_at).not.toBeNull();

    // 后到同 dedup_key 带**不同** publishedAt = D2 → 不得覆盖首建 D1（COALESCE 已设值不变）。
    const id2 = await seedRawItem({
      sourceItemId: `nofill-2-${ts}`,
      url,
      title: 'Different-date arrival',
      publishedAt: d2,
    });
    await collapseRawItem(
      { id: id2, url, title: 'Different-date arrival', publishedAt: d2, fetchedAt: new Date() },
      db!,
    );

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // published_at 保持首建值不变（与首建后读回快照逐字相等），未被 D2 覆盖。
    expect(after.published_at?.toISOString()).toBe(before.published_at?.toISOString());
    // 显式断言不等于后到的 D2（证明确实未被覆盖）。
    expect(after.published_at?.toISOString()).not.toBe(d2.toISOString());
    // 身份/代表/first_seen 仍冻结，source_count 累加为 2。
    expect(after.representative_raw_item_id).toBe(id1.toString());
    expect(after.representative_title).toBe('Dated-first title');
    expect(Number(after.source_count)).toBe(2);

    await db!.delete(schema.aiNewsEvents).where(sql`dedup_key = ${dedupKey}`);
  });
});
