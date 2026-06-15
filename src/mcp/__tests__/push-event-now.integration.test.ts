/**
 * push_event_now 集成测试（task 6.3）——需本地 Postgres（compose 起的）。
 *
 * **test-no-prod-sends 红线（最高优先级）**：push_event_now 的 handler 动态 import
 * `telegram.js`/`feishu.js` 的 sender 工厂。本套件用 `vi.mock` 让
 * `createTelegramSender`/`createFeishuSender` 返回**捕获型 mock sender**（记录 payload、绝不真发）；
 * dispatcher 用**真** `dispatchDigest` + 测试 db（handler 内以 getContext().db 作第三参 dbh），
 * 可验真幂等（未推 success 写 push_records、已推唯一键跳过）。「未配 token → isError」用 mock 工厂
 * throw 模拟。绝不让任何真实 telegram/feishu sender 被构造（VITEST 守卫是兜底、此处主动 mock）。
 *
 * 覆盖：
 * - 未推 → success（单段 renderDigest）、写 push_records=success、mock sender 收到一次调用。
 * - 已推 → 幂等跳过（唯一键冲突、sender 不再被调）。
 * - 未配 token（mock 工厂 throw）→ isError 文案、不 throw 断连。
 * - 多 channel 一个失败隔离其余照常（telegram 成功 + feishu 工厂 throw）。
 * - 事件不存在 → isError。
 *
 * 隔离：本套件造的 event 用唯一 dedup_key 前缀 + 专属 push_date；afterAll 清理。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// dispatcher → db/index.ts → config/env.ts 的全局 parseEnv 要求全部 required env；
// 注入占位让无真实推送/LLM 凭据也能 import（真实 DATABASE_URL 仍由 .env 提供，缺则套件 skip）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph';

// ── 捕获型 mock sender（绝不真发；记录调用）──────────────────────────────────
/** 每个 channel 一份「下次 createXxxSender 行为」控制 + 调用记录。 */
const tg = { calls: [] as Array<{ text: string }>, throwOnCreate: null as string | null };
const fs = { calls: [] as Array<{ text: string }>, throwOnCreate: null as string | null };

vi.mock('../../push/telegram.js', () => ({
  createTelegramSender: () => {
    if (tg.throwOnCreate) throw new Error(tg.throwOnCreate);
    return {
      async send(text: string) {
        tg.calls.push({ text });
      },
    };
  },
}));
vi.mock('../../push/feishu.js', () => ({
  createFeishuSender: () => {
    if (fs.throwOnCreate) throw new Error(fs.throwOnCreate);
    return {
      async send(text: string) {
        fs.calls.push({ text });
      },
    };
  },
}));

const { aiNewsEvents } = await import('../../db/schema.js');
const { setContext } = await import('../context.js');
const { pushEventNowTool } = await import('../tools/push-event-now.js');
const { makeEnv, canRun, db, pool } = await import('./helpers.js');
type CallToolResult = import('@modelcontextprotocol/sdk/types.js').CallToolResult;

const PREFIX = 'mcptest-push-';

/** 造一条 event（供 push_event_now 读取拼消息），返回 event_id。 */
async function seedEvent(key: string): Promise<string> {
  const rows = await db!
    .insert(aiNewsEvents)
    .values({
      dedupKey: `${PREFIX}${key}`,
      representativeTitle: `push-${key}`,
      summaryZh: '摘要',
      sourceCount: 1,
    })
    .returning({ eventId: aiNewsEvents.eventId });
  return rows[0]!.eventId;
}

/** 查某 event 在某 channel 的 push_records 状态。 */
async function pushStatus(eventId: string, channel: string): Promise<string[]> {
  const { rows } = await pool!.query<{ status: string }>(
    `SELECT status FROM push_records
      WHERE target_type='event' AND target_id=$1 AND channel=$2
      ORDER BY status`,
    [eventId, channel],
  );
  return rows.map((r) => r.status);
}

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM push_records WHERE target_id IN
       (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await cleanup();
  // 默认 telegram-only env（feishu 未配 → resolveChannels 默认仅 telegram）。
  if (db) setContext({ env: makeEnv(), db });
});
afterAll(async () => {
  await cleanup();
  await pool?.end();
});
beforeEach(() => {
  tg.calls = [];
  fs.calls = [];
  tg.throwOnCreate = null;
  fs.throwOnCreate = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!canRun)('push_event_now（复用 dispatchDigest 幂等、mock sender 不真发）', () => {
  it('未推 → success：写 push_records=success，mock telegram sender 收到一次调用', async () => {
    const eventId = await seedEvent('ok1');
    const res = (await pushEventNowTool.handler(
      { eventId, channel: 'telegram' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('[telegram]');
    expect(text).toContain('已推送');
    expect(tg.calls).toHaveLength(1); // 真发被 mock 拦截、记录一次。
    expect(fs.calls).toHaveLength(0);
    expect(await pushStatus(eventId, 'telegram')).toEqual(['success']);
  });

  it('已推 → 幂等跳过：唯一键冲突、sender 不再被调', async () => {
    const eventId = await seedEvent('idem');
    // 第一次推 → success。
    await pushEventNowTool.handler({ eventId, channel: 'telegram' }, {});
    tg.calls = []; // 清掉第一次调用记录。

    // 第二次推 → 待发集合为空（已 success）→ dispatcher skipped、sender 不被调。
    const res = (await pushEventNowTool.handler(
      { eventId, channel: 'telegram' },
      {},
    )) as CallToolResult;
    expect(res.isError).not.toBe(true);
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('已跳过');
    expect(tg.calls).toHaveLength(0); // 幂等：不重复发。
    expect(await pushStatus(eventId, 'telegram')).toEqual(['success']); // 仍一行 success。
  });

  it('未配 token（mock 工厂 throw）→ isError 文案、不 throw 断连', async () => {
    const eventId = await seedEvent('notoken');
    tg.throwOnCreate = '缺少 TELEGRAM_BOT_TOKEN';

    const res = (await pushEventNowTool.handler(
      { eventId, channel: 'telegram' },
      {},
    )) as CallToolResult;
    // 工厂 throw 被 pushOnChannel 的 try/catch 兜成失败文案（content 文本，非 throw）。
    expect(() => res).not.toThrow();
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('[telegram]');
    expect(text).toContain('缺少 TELEGRAM_BOT_TOKEN');
    expect(tg.calls).toHaveLength(0); // 工厂没成功构造 → 没发。
    // push_records 不应有该事件 success（dispatcher 在拿到 sender 前就没机会写）。
    const statuses = await pushStatus(eventId, 'telegram');
    expect(statuses).not.toContain('success');
  });

  it('多 channel 一个失败隔离其余照常（telegram 成功 + feishu 工厂 throw）', async () => {
    const eventId = await seedEvent('multi');
    // 配齐 feishu env 使 resolveChannels 纳入 feishu；feishu 工厂 throw 模拟其凭据/构造失败。
    if (db) {
      setContext({
        env: makeEnv({
          FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook/test',
          FEISHU_SIGN_SECRET: 'sign-secret',
        }),
        db,
      });
    }
    fs.throwOnCreate = '飞书构造失败（模拟缺凭据）';

    // 不传 channel → resolveChannels 返回 [telegram, feishu]。
    const res = (await pushEventNowTool.handler({ eventId }, {})) as CallToolResult;
    const text = (res.content?.[0] as { text?: string }).text ?? '';

    // telegram 成功隔离不受 feishu 失败影响。
    expect(text).toContain('[telegram]');
    expect(text).toContain('已推送');
    expect(tg.calls).toHaveLength(1);
    expect(await pushStatus(eventId, 'telegram')).toEqual(['success']);

    // feishu 失败但只影响自己。
    expect(text).toContain('[feishu]');
    expect(text).toContain('飞书构造失败');
    expect(fs.calls).toHaveLength(0);
    expect(await pushStatus(eventId, 'feishu')).not.toContain('success');

    // 复位默认 telegram-only env。
    if (db) setContext({ env: makeEnv(), db });
  });

  it('事件不存在 → isError', async () => {
    const res = (await pushEventNowTool.handler(
      { eventId: 'no-such-push-event-xyz', channel: 'telegram' },
      {},
    )) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('不存在');
    expect(tg.calls).toHaveLength(0);
  });
});
