/**
 * 标记干预工具集成测试（task 6.2）——需本地 Postgres（compose 起的）。
 *
 * 覆盖：
 * - mark_event_not_relevant：置 should_push=false（events 无 metadata 列、reason 不入库）；
 *   目标不存在 → isError:true；重复幂等（再调结果一致、仍 should_push=false）。
 * - mark_product_interesting：metadata.interesting 原子 merge 写入（含 note）；
 *   目标不存在 → isError:true；重复幂等（覆盖不报错）。
 *
 * 隔离：本套件造的 event/product 用唯一 dedup_key/name 前缀；afterAll 清理。
 * 直接调 `xxxTool.handler(args, {})`（调前 setContext 注入测试 db + 局部宽松 env）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiNewsEvents, aiProducts } from '../../db/schema.js';
import { setContext } from '../context.js';
import { markEventTool } from '../tools/mark-event.js';
import { markProductTool } from '../tools/mark-product.js';
import { canRun, db, makeEnv, pool } from './helpers.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const PREFIX = 'mcptest-mark-';
const env = makeEnv();

async function seedEvent(key: string): Promise<string> {
  const rows = await db!
    .insert(aiNewsEvents)
    .values({
      dedupKey: `${PREFIX}${key}`,
      representativeTitle: `mark-${key}`,
      shouldPush: true, // 初始 true，验 mark 后置 false。
      sourceCount: 1,
    })
    .returning({ eventId: aiNewsEvents.eventId });
  return rows[0]!.eventId;
}

async function seedProduct(key: string): Promise<string> {
  const rows = await db!
    .insert(aiProducts)
    .values({ name: `${PREFIX}${key}` })
    .returning({ productId: aiProducts.productId });
  return rows[0]!.productId;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await cleanup();
  if (db) setContext({ env, db });
});
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!canRun)('mark_event_not_relevant', () => {
  it('置 should_push=false（events 无 metadata 写）；reason 不入库', async () => {
    const eventId = await seedEvent('ev1');
    const res = (await markEventTool.handler(
      { eventId, reason: '与 AI 无关' },
      {},
    )) as CallToolResult;
    expect(res.isError).not.toBe(true);

    const rows = await db!
      .select({ shouldPush: aiNewsEvents.shouldPush })
      .from(aiNewsEvents)
      .where(eq(aiNewsEvents.eventId, eventId));
    expect(rows[0]!.shouldPush).toBe(false);
    // events 表无 metadata 列，reason 只记日志/返回——无可断言的 DB 副作用（列不存在即证）。
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('与 AI 无关'); // reason 回显在返回文本里。
  });

  it('目标不存在 → isError:true', async () => {
    const res = (await markEventTool.handler(
      { eventId: 'no-such-event-id-xyz' },
      {},
    )) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('不存在');
  });

  it('重复标记幂等：再调仍成功、should_push 仍为 false', async () => {
    const eventId = await seedEvent('ev-idem');
    const r1 = (await markEventTool.handler({ eventId }, {})) as CallToolResult;
    const r2 = (await markEventTool.handler({ eventId }, {})) as CallToolResult;
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
    const rows = await db!
      .select({ shouldPush: aiNewsEvents.shouldPush })
      .from(aiNewsEvents)
      .where(eq(aiNewsEvents.eventId, eventId));
    expect(rows[0]!.shouldPush).toBe(false);
  });
});

describe.skipIf(!canRun)('mark_product_interesting', () => {
  it('metadata.interesting 原子 merge 写入（含 note + at）', async () => {
    const productId = await seedProduct('p1');
    const res = (await markProductTool.handler(
      { productId, note: '值得跟进' },
      {},
    )) as CallToolResult;
    expect(res.isError).not.toBe(true);

    const rows = await db!
      .select({ metadata: aiProducts.metadata })
      .from(aiProducts)
      .where(eq(aiProducts.productId, productId));
    const meta = rows[0]!.metadata as { interesting?: { at?: string; note?: string } } | null;
    expect(meta?.interesting).toBeDefined();
    expect(meta!.interesting!.note).toBe('值得跟进');
    expect(meta!.interesting!.at).toBeTruthy(); // 库端 now() 写入时间。
  });

  it('原子 merge 不覆盖既有其它 metadata 键', async () => {
    const productId = await seedProduct('p-merge');
    // 预置一个无关键。
    await db!
      .update(aiProducts)
      .set({ metadata: { keep: 'this' } })
      .where(eq(aiProducts.productId, productId));

    await markProductTool.handler({ productId, note: 'n' }, {});
    const rows = await db!
      .select({ metadata: aiProducts.metadata })
      .from(aiProducts)
      .where(eq(aiProducts.productId, productId));
    const meta = rows[0]!.metadata as { keep?: string; interesting?: unknown };
    expect(meta.keep).toBe('this'); // 既有键保留。
    expect(meta.interesting).toBeDefined(); // 新键合并。
  });

  it('目标不存在 → isError:true', async () => {
    const res = (await markProductTool.handler(
      { productId: 'no-such-product-id-xyz' },
      {},
    )) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('不存在');
  });

  it('重复标记幂等：再调覆盖、不报错', async () => {
    const productId = await seedProduct('p-idem');
    const r1 = (await markProductTool.handler({ productId, note: 'first' }, {})) as CallToolResult;
    const r2 = (await markProductTool.handler({ productId, note: 'second' }, {})) as CallToolResult;
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
    const rows = await db!
      .select({ metadata: aiProducts.metadata })
      .from(aiProducts)
      .where(eq(aiProducts.productId, productId));
    const meta = rows[0]!.metadata as { interesting?: { note?: string } };
    expect(meta.interesting!.note).toBe('second'); // 覆盖为最后一次。
  });
});
