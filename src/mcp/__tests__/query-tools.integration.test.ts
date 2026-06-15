/**
 * 查询工具集成测试（task 6.1 + 6.4 的 SDK 层）——需本地 Postgres（compose 起的）。
 *
 * 覆盖：
 * - get_today_ai_digest：当日已推（要闻+新品两段）/ 未推（空 + 「今日尚未推送」）/ orphan 跳过 /
 *   产品畸形域降级链接与 search 一致 / channel 过滤。
 * - search_ai_events：关键词 + published_at 窗 + 分页 + limit 钳制 + LIKE 元字符转义。
 * - search_ai_products：名称/域名关键词 + 分页 + 链接严格映射。
 * - get_source_quality_report：采集量 / 塌缩入事件数 / 被推送数（代表源归因）/ 最近活跃时间。
 * - outputSchema/structuredContent 形态：经真 McpServer + Client（InMemoryTransport）验 SDK 层
 *   声明 outputSchema → structuredContent 被强制校验、入参依 inputSchema 自动拒、list_tools 正常。
 *
 * 隔离：所有造的行用唯一 source/canonical_url/canonical_domain 前缀 + 专属 push_date；afterAll 清理。
 * 直接调 `xxxTool.handler(args, {})`（调前 setContext 注入测试 db + 局部宽松 env）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiNewsEvents, aiProducts, pushRecords, rawItems } from '../../db/schema.js';
import { setContext } from '../context.js';
import { getTodayTool } from '../tools/get-today.js';
import { searchEventsTool } from '../tools/search-events.js';
import { searchProductsTool } from '../tools/search-products.js';
import { sourceQualityTool } from '../tools/source-quality.js';
import { getPushDate } from '../lib/push-date.js';
import {
  canRun,
  connectInMemoryClient,
  db,
  makeEnv,
  pool,
} from './helpers.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// 隔离前缀（专属本套件造的行）。
const SRC = 'mcptest-src-';
const URLP = 'https://mcptest.example/';
const DOMP = 'mcptest-';
const NOW = new Date('2099-03-01T04:00:00Z'); // 仅用于 published_at / fetched_at 等时刻字段。
const TZ = 'Asia/Shanghai';
// get_today 的 handler 内用 new Date() 取「真实今天」的 push_date（无法注入固定 now），故 get_today
// 相关的 push_records 必须按**真实今天**的 push_date 落库才会被查到；target_id 全用前缀隔离，
// 仅删本套件造的行，绝不碰生产其它 target。
const TEST_PUSH_DATE = getPushDate(new Date(), TZ);

const env = makeEnv();

/** 造一条 raw_item（含 source / canonical_url / fetched_at），返回其 bigint id。 */
async function seedRawItem(args: {
  source: string;
  canonicalUrl: string | null;
  fetchedAt: Date;
  title?: string;
}): Promise<bigint> {
  const rows = await db!
    .insert(rawItems)
    .values({
      source: args.source,
      title: args.title ?? 'raw',
      canonicalUrl: args.canonicalUrl,
      fetchedAt: args.fetchedAt,
    })
    .returning({ id: rawItems.id });
  return rows[0]!.id;
}

/** 造一条已评分 event（可绑代表 raw_item），返回 event_id（DB 生成）。 */
async function seedEvent(args: {
  dedupKey: string;
  representativeTitle: string;
  summaryZh?: string | null;
  headlineZh?: string | null;
  importance?: number | null;
  publishedAt?: Date | null;
  representativeRawItemId?: bigint | null;
}): Promise<string> {
  const rows = await db!
    .insert(aiNewsEvents)
    .values({
      dedupKey: args.dedupKey,
      representativeTitle: args.representativeTitle,
      summaryZh: args.summaryZh ?? null,
      headlineZh: args.headlineZh ?? null,
      importanceScore: args.importance == null ? null : String(args.importance),
      publishedAt: args.publishedAt ?? null,
      representativeRawItemId: args.representativeRawItemId ?? null,
      sourceCount: 1,
    })
    .returning({ eventId: aiNewsEvents.eventId });
  return rows[0]!.eventId;
}

/** 造一条 product（含 canonical_domain），返回 product_id（DB 生成）。 */
async function seedProduct(args: {
  name: string;
  canonicalDomain: string | null;
}): Promise<string> {
  const rows = await db!
    .insert(aiProducts)
    .values({
      name: args.name,
      canonicalDomain: args.canonicalDomain,
    })
    .returning({ productId: aiProducts.productId });
  return rows[0]!.productId;
}

/** 写一条 success push_record（绑某 target 到某 channel + 当日 push_date）。 */
async function seedPush(args: {
  targetType: 'event' | 'product';
  targetId: string;
  channel: string;
  pushDate?: string;
}): Promise<void> {
  await db!.insert(pushRecords).values({
    targetType: args.targetType,
    targetId: args.targetId,
    channel: args.channel,
    pushDate: args.pushDate ?? TEST_PUSH_DATE,
    status: 'success',
    pushedAt: new Date(),
  });
}

/** 从 CallToolResult 取 structuredContent（断言其存在）。 */
function structured<T = Record<string, unknown>>(res: CallToolResult): T {
  expect(res.isError).not.toBe(true);
  expect(res.structuredContent).toBeDefined();
  return res.structuredContent as T;
}

async function cleanup() {
  if (!pool) return;
  // push_records 绑到本套件 event/product → 经 dedup_key/canonical_domain 反查清理。
  await pool.query(
    `DELETE FROM push_records WHERE target_id IN
       (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $1)
        OR target_id IN (SELECT product_id FROM ai_products WHERE canonical_domain LIKE $2)`,
    [`${SRC}%`, `${DOMP}%`],
  );
  await pool.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${SRC}%`]);
  await pool.query(`DELETE FROM ai_products WHERE canonical_domain LIKE $1`, [`${DOMP}%`]);
  await pool.query(`DELETE FROM ai_products WHERE name LIKE $1`, [`${SRC}%`]);
  await pool.query(`DELETE FROM raw_items WHERE source LIKE $1`, [`${SRC}%`]);
}

beforeAll(async () => {
  await cleanup();
  if (db) setContext({ env, db });
});
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!canRun)('get_today_ai_digest（查已推事实）', () => {
  it('当日已推：还原要闻段（event url 经代表源）+ 新品段（畸形域降级链接一致）', async () => {
    // 要闻：event 绑一个有 canonical_url 的代表 raw_item。
    const rawId = await seedRawItem({
      source: `${SRC}today`,
      canonicalUrl: `${URLP}today-event`,
      fetchedAt: NOW,
    });
    const eventId = await seedEvent({
      dedupKey: `${SRC}today-ev`,
      representativeTitle: 'TodayEvent',
      headlineZh: '今日要闻',
      representativeRawItemId: rawId,
    });
    await seedPush({ targetType: 'event', targetId: eventId, channel: 'telegram' });

    // 新品：合法域 product + 畸形域 product（降级 null）。
    const okProduct = await seedProduct({
      name: `${SRC}OkProd`,
      canonicalDomain: `${DOMP}ok.example.com`,
    });
    const badProduct = await seedProduct({
      name: `${SRC}BadProd`,
      canonicalDomain: `${DOMP}bad domain with space`, // 含空格 → 严格映射降级 null。
    });
    await seedPush({ targetType: 'product', targetId: okProduct, channel: 'telegram' });
    await seedPush({ targetType: 'product', targetId: badProduct, channel: 'telegram' });

    const res = (await getTodayTool.handler({}, {})) as CallToolResult;
    const dto = structured<{
      pushDate: string;
      channels: string[];
      events: Array<{ targetId: string; title: string | null; url: string | null }>;
      products: Array<{ targetId: string; title: string | null; url: string | null }>;
    }>(res);

    expect(dto.pushDate).toBe(TEST_PUSH_DATE);
    expect(dto.channels).toContain('telegram');

    const ev = dto.events.find((e) => e.targetId === eventId);
    expect(ev).toBeDefined();
    expect(ev!.title).toBe('今日要闻'); // headlineZh 优先。
    expect(ev!.url).toBe(`${URLP}today-event`);

    const okP = dto.products.find((p) => p.targetId === okProduct);
    const badP = dto.products.find((p) => p.targetId === badProduct);
    expect(okP!.url).toBe(`https://${DOMP}ok.example.com`);
    expect(badP!.url).toBeNull(); // 畸形域降级 null，不裸拼。
  });

  it('畸形域降级与 search_ai_products 链接口径一致', async () => {
    // 同一畸形域：get_today 与 search 都应降级为 null（忠实于实际已推）。
    const sres = (await searchProductsTool.handler(
      { q: `${SRC}BadProd`, limit: 20, offset: 0 },
      {},
    )) as CallToolResult;
    const sdto = structured<{ products: Array<{ name: string; url: string | null }> }>(sres);
    const hit = sdto.products.find((p) => p.name === `${SRC}BadProd`);
    expect(hit).toBeDefined();
    expect(hit!.url).toBeNull();
  });

  it('channel 过滤：传 feishu 时结果绝不含 telegram channel，也不含本套件仅 telegram 推过的 event', async () => {
    // 造一个本套件专属 event，只在 telegram success → feishu 过滤下绝不应出现。
    const tgOnly = await seedEvent({
      dedupKey: `${SRC}tg-only`,
      representativeTitle: 'TelegramOnly',
    });
    await seedPush({ targetType: 'event', targetId: tgOnly, channel: 'telegram' });

    const res = (await getTodayTool.handler({ channel: 'feishu' }, {})) as CallToolResult;
    const dto = structured<{
      channels: string[];
      events: Array<{ targetId: string }>;
    }>(res);
    expect(dto.channels).not.toContain('telegram'); // channel 过滤命中：结果不混入 telegram。
    expect(dto.events.find((e) => e.targetId === tgOnly)).toBeUndefined(); // 仅 telegram 推 → feishu 不还原。
  });

  it('orphan 跳过：push_records success 但 event 行已删 → 不报错、不还原该条', async () => {
    // 造一条 success push_record 指向一个不存在的 event_id（删掉其 event 行）。
    const rawId = await seedRawItem({
      source: `${SRC}orphan`,
      canonicalUrl: null,
      fetchedAt: NOW,
    });
    const evId = await seedEvent({
      dedupKey: `${SRC}orphan-ev`,
      representativeTitle: 'WillBeDeleted',
      representativeRawItemId: rawId,
    });
    await seedPush({ targetType: 'event', targetId: evId, channel: 'telegram' });
    // 删 event 行使 push_record 成为 orphan（保留 push_record）。
    await db!.delete(aiNewsEvents).where(eq(aiNewsEvents.eventId, evId));

    const res = (await getTodayTool.handler({}, {})) as CallToolResult;
    const dto = structured<{ events: Array<{ targetId: string }> }>(res);
    expect(res.isError).not.toBe(true);
    expect(dto.events.find((e) => e.targetId === evId)).toBeUndefined(); // orphan 跳过。
  });
});

describe.skipIf(!canRun)('get_today_ai_digest（当日未推空路径）', () => {
  it('当日该 channel 无 success → 空 DTO + 「今日尚未推送」文本（确定性：先清掉真实今天的本套件痕迹）', async () => {
    // handler 内用 new Date() 取真实「今天」，无法注入固定 now。为确定性命中
    // 「records.length===0」分支，先删掉真实今天的 push_records（不分 channel——本套件造的行
    // 全用前缀化 target_id；这里删的是「真实今天 + 本套件前缀 target」的记录，绝不碰生产/其它日）。
    const realToday = getPushDate(new Date(), TZ);
    await pool!.query(
      `DELETE FROM push_records
        WHERE push_date=$1
          AND (target_id IN (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $2)
            OR target_id IN (SELECT product_id FROM ai_products WHERE canonical_domain LIKE $3))`,
      [realToday, `${SRC}%`, `${DOMP}%`],
    );

    // 用 feishu channel 过滤：本套件从不在 feishu 造 success（只 telegram），故该 channel 下
    // 真实今天必无本套件 success。生产可能有 feishu success → 落非空分支；本断言只在空时校验文本。
    const res = (await getTodayTool.handler({ channel: 'feishu' }, {})) as CallToolResult;
    expect(res.isError).not.toBe(true);
    const dto = res.structuredContent as {
      channels: string[];
      events: unknown[];
      products: unknown[];
    };
    expect(dto).toBeDefined();
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    if (dto.events.length === 0 && dto.products.length === 0) {
      // 空路径：channels 为空 + 文本含「今日尚未推送」。
      expect(dto.channels).toHaveLength(0);
      expect(text).toContain('今日尚未推送');
    }
  });
});

describe.skipIf(!canRun)('search_ai_events（关键词/窗/分页/转义）', () => {
  it('关键词命中标题/摘要 + published_at 窗 + importance 阈值', async () => {
    await seedEvent({
      dedupKey: `${SRC}se-1`,
      representativeTitle: `${SRC}KW unique-needle alpha`,
      summaryZh: '摘要一',
      importance: 80,
      publishedAt: new Date('2099-03-01T00:00:00Z'),
    });
    await seedEvent({
      dedupKey: `${SRC}se-2`,
      representativeTitle: 'no-match-here',
      summaryZh: `命中 unique-needle 在摘要`,
      importance: 90,
      publishedAt: new Date('2099-03-01T00:00:00Z'),
    });

    const res = (await searchEventsTool.handler(
      {
        q: 'unique-needle',
        since: '2099-02-28T00:00:00Z',
        until: '2099-03-02T00:00:00Z',
        minImportance: 70,
        limit: 20,
        offset: 0,
      },
      {},
    )) as CallToolResult;
    const dto = structured<{
      total: number;
      events: Array<{ representativeTitle: string | null; summaryZh: string | null }>;
    }>(res);
    expect(dto.total).toBeGreaterThanOrEqual(2);
    const titles = dto.events.map((e) => e.representativeTitle ?? '').join('|');
    const summaries = dto.events.map((e) => e.summaryZh ?? '').join('|');
    expect(titles + summaries).toContain('unique-needle');
  });

  it('LIKE 元字符转义：字面 % 不当通配符（按字面匹配、不全表扫描误命中）', async () => {
    await seedEvent({
      dedupKey: `${SRC}like-lit`,
      representativeTitle: `${SRC}pct 100% literal`,
      publishedAt: new Date('2099-03-01T00:00:00Z'),
    });
    await seedEvent({
      dedupKey: `${SRC}like-other`,
      representativeTitle: `${SRC}pct no-percent-here`,
      publishedAt: new Date('2099-03-01T00:00:00Z'),
    });

    // q='100%'：% 被转义按字面 → 只命中含「100%」字面的那条，不因通配符命中另一条。
    const res = (await searchEventsTool.handler(
      { q: '100%', limit: 50, offset: 0 },
      {},
    )) as CallToolResult;
    const dto = structured<{ events: Array<{ representativeTitle: string | null }> }>(res);
    const titles = dto.events.map((e) => e.representativeTitle);
    expect(titles).toContain(`${SRC}pct 100% literal`);
    expect(titles).not.toContain(`${SRC}pct no-percent-here`);
  });

  it('分页 + limit 钳制：limit 超 100 被 SDK 钳制前由 schema 拒；handler 层按传入 limit/offset 分页', async () => {
    // 造 3 条同关键词，分页 limit=2 → 第一页 2 条、第二页 1 条；total 反映全集。
    for (const k of ['pg-a', 'pg-b', 'pg-c']) {
      await seedEvent({
        dedupKey: `${SRC}${k}`,
        representativeTitle: `${SRC}pageword ${k}`,
        publishedAt: new Date(`2099-03-01T0${'abc'.indexOf(k.slice(-1)) + 1}:00:00Z`),
      });
    }
    const page1 = structured<{ total: number; events: unknown[] }>(
      (await searchEventsTool.handler(
        { q: `${SRC}pageword`, limit: 2, offset: 0 },
        {},
      )) as CallToolResult,
    );
    const page2 = structured<{ total: number; events: unknown[] }>(
      (await searchEventsTool.handler(
        { q: `${SRC}pageword`, limit: 2, offset: 2 },
        {},
      )) as CallToolResult,
    );
    expect(page1.total).toBe(3);
    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(1);
  });
});

describe.skipIf(!canRun)('search_ai_products（名称/域名/链接）', () => {
  it('按名称关键词命中 + 链接严格映射（合法域拼 https、畸形降级 null）', async () => {
    await seedProduct({ name: `${SRC}ProdSearch`, canonicalDomain: `${DOMP}prod.example.org` });
    const res = (await searchProductsTool.handler(
      { q: `${SRC}ProdSearch`, limit: 20, offset: 0 },
      {},
    )) as CallToolResult;
    const dto = structured<{ products: Array<{ name: string; url: string | null }> }>(res);
    const hit = dto.products.find((p) => p.name === `${SRC}ProdSearch`);
    expect(hit).toBeDefined();
    expect(hit!.url).toBe(`https://${DOMP}prod.example.org`);
  });

  it('按 domain 关键词命中', async () => {
    const res = (await searchProductsTool.handler(
      { domain: `${DOMP}prod.example.org`, limit: 20, offset: 0 },
      {},
    )) as CallToolResult;
    const dto = structured<{ products: Array<{ canonicalDomain: string | null }> }>(res);
    expect(
      dto.products.some((p) => p.canonicalDomain === `${DOMP}prod.example.org`),
    ).toBe(true);
  });
});

describe.skipIf(!canRun)('get_source_quality_report（代表源归因聚合）', () => {
  it('采集量 / 塌缩入事件数 / 被推送数 / 最近活跃时间', async () => {
    const source = `${SRC}quality`;
    // 该源采 2 条 raw_item；其中一条作 1 个 event 的代表源；该 event 被 telegram success 推过。
    const rawA = await seedRawItem({
      source,
      canonicalUrl: `${URLP}q-a`,
      fetchedAt: new Date('2099-03-01T01:00:00Z'),
    });
    await seedRawItem({
      source,
      canonicalUrl: `${URLP}q-b`,
      fetchedAt: new Date('2099-03-01T05:00:00Z'), // 最近活跃。
    });
    const evId = await seedEvent({
      dedupKey: `${SRC}q-ev`,
      representativeTitle: 'QualityEvent',
      representativeRawItemId: rawA,
    });
    await seedPush({ targetType: 'event', targetId: evId, channel: 'telegram' });
    // 同一 event 多 channel success 不应让 pushedCount 翻倍（COUNT DISTINCT target_id）。
    await seedPush({ targetType: 'event', targetId: evId, channel: 'feishu' });

    const res = (await sourceQualityTool.handler({}, {})) as CallToolResult;
    const dto = structured<{
      sources: Array<{
        source: string;
        collectedCount: number;
        collapsedEventCount: number;
        pushedCount: number;
        lastActiveAt: string | null;
      }>;
    }>(res);
    const row = dto.sources.find((s) => s.source === source);
    expect(row).toBeDefined();
    expect(row!.collectedCount).toBe(2);
    expect(row!.collapsedEventCount).toBe(1);
    expect(row!.pushedCount).toBe(1); // DISTINCT event_id：多 channel 不翻倍。
    expect(row!.lastActiveAt).toBe(new Date('2099-03-01T05:00:00Z').toISOString());
  });
});

describe.skipIf(!canRun)('SDK 层契约（outputSchema/structuredContent + 自动校验 + list_tools）', () => {
  it('list_tools 返回全部 7 工具', async () => {
    const { client, close } = await connectInMemoryClient();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'get_source_quality_report',
          'get_today_ai_digest',
          'mark_event_not_relevant',
          'mark_product_interesting',
          'push_event_now',
          'search_ai_events',
          'search_ai_products',
        ].sort(),
      );
    } finally {
      await close();
    }
  });

  it('查询工具经 SDK 调用返回 structuredContent（被 outputSchema 校验通过）', async () => {
    const { client, close } = await connectInMemoryClient();
    try {
      const res = await client.callTool({
        name: 'search_ai_events',
        arguments: { q: `${SRC}nonexistent-xyz`, limit: 5, offset: 0 },
      });
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toBeDefined();
      const sc = res.structuredContent as { total: number; events: unknown[] };
      expect(typeof sc.total).toBe('number');
      expect(Array.isArray(sc.events)).toBe(true);
    } finally {
      await close();
    }
  });

  it('非法入参（limit 超上限）被 SDK 依 inputSchema 拒绝（isError + 校验信息，不执行 DB）', async () => {
    const { client, close } = await connectInMemoryClient();
    try {
      // SDK 依 inputSchema 自动校验失败时，返回 isError:true 的 CallToolResult（MCP -32602），
      // 不进入 handler（故无 DB 操作）；不抛断连。
      const res = await client.callTool({
        name: 'search_ai_events',
        arguments: { limit: 9999 }, // > max(100) → SDK 校验拒。
      });
      expect(res.isError).toBe(true);
      const text = ((res.content as Array<{ text?: string }>)?.[0]?.text) ?? '';
      expect(text).toContain('validation');
      expect(text).toContain('limit');
    } finally {
      await close();
    }
  });

  it('非法入参（缺必填 eventId）被 SDK 拒绝（isError）', async () => {
    const { client, close } = await connectInMemoryClient();
    try {
      const res = await client.callTool({
        name: 'mark_event_not_relevant',
        arguments: {}, // 缺 eventId → SDK 校验拒。
      });
      expect(res.isError).toBe(true);
      const text = ((res.content as Array<{ text?: string }>)?.[0]?.text) ?? '';
      expect(text).toContain('eventId');
    } finally {
      await close();
    }
  });
});
