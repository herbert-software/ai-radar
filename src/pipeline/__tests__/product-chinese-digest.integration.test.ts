/**
 * 产品中文化集成测试（capability product-chinese-digest，design D3/D4/D7，tasks 8.2/8.3/8.7/8.8）。
 *
 * 连真库（docker-compose Postgres）。覆盖编排零件 digestPendingProducts、选品映射
 * selectProductCandidates 读中文列、失败语义分层、部署假绿守卫 assertProductZhColumns。
 *
 * **不真调 LLM**：digestPendingProducts 经 summarizeOptions.generateObjectFn 注入 mock。
 *
 * 覆盖（逐条对齐 tasks）：
 * - 8.2 候选 = 各 channel 候选**精确并集**（merge_conflict 排除 / name_zh IS NULL / UNION 覆盖
 *   per-channel top-N —— 构造「已推 tg 未推 feishu」产品验证被覆盖中文化）；占位名不入候选；
 *   channels 空直接 return；已 name_zh 跳过 LLM（幂等）。
 * - 8.3 selectProductCandidates 映射：中文化产品 representativeTitle=nameZh、headlineZh=taglineZh；
 *   未中文化回退英文 name + headlineZh=null；选品条件不变。
 * - 8.7 失败语义：单产品业务失败（ProductDigestFailureError）保持 NULL 继续、整步不抛；系统级异常
 *   （DB 断连，非 ProductDigestFailureError）整步仍不抛但触发 alert（注入 alert spy 断言）。
 * - 8.8 部署假绿守卫：assertProductZhColumns 列存在则通过、缺列/探针失败则 fail-fast 抛错。
 *
 * 缺 DATABASE_URL 时本套件自动跳过；唯一 product_id 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

// 注入占位 env 让无真实凭据也能 import config/env（启动期校验）；DATABASE_URL 仍由 .env/CI 注入。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const {
  selectProductCandidates,
  digestPendingProducts,
  assertProductZhColumns,
} = await import('../product-digest.js');
const { UNNAMED_PRODUCT_NAME } = await import('../../collectors/product-collapse.js');

const databaseUrl = process.env.DATABASE_URL;
const canRun = Boolean(databaseUrl);

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const PREFIX = `pcd-itest-${process.pid}-`;
const PUSH_DATE_1 = '2099-04-01';

/**
 * 注入的 `generateObjectFn`（LLM 层 mock，不真调 LLM）。其入参是 generateObject 的 `{model,
 * schema, prompt}`——产品名在 `prompt` 里（summarizeProduct.buildPrompt 写入「产品名：<name>」）。
 *
 * 成功 mock：仅对 prompt 含本套件前缀的产品返回固定 name_zh / tagline_zh；对任何**非本套件**产品
 * （dev/CI 库里可能存在的真实候选）返回**空 name_zh**（→ Zod 校验不过 → summarizeProduct 降级抛
 * ProductDigestFailureError → 保持 NULL、不写库），绝不污染外部行。digestPendingProducts
 * channel-blind 扫全表候选，故须此防护。
 */
function okSummarize(out = { name_zh: '某中文译名', tagline_zh: '某中文简介。' }) {
  return vi.fn().mockImplementation(async (args: { prompt: string }) => {
    if (!args.prompt.includes(PREFIX)) {
      return { object: { name_zh: '', tagline_zh: '' } }; // 外部产品：空输出 → Zod 不过 → 降级保 NULL。
    }
    return { object: out };
  });
}

/** 插一条 ai_products，返回 product_id（用前缀 + 显式 product_id 隔离）。 */
async function seedProduct(args: {
  suffix: string;
  name?: string;
  nameZh?: string | null;
  taglineZh?: string | null;
  canonicalDomain?: string | null;
  metadata?: Record<string, unknown> | null;
  representativeRawItemId?: bigint | null;
}): Promise<string> {
  const productId = `${PREFIX}${args.suffix}`;
  await pool!.query(
    `INSERT INTO ai_products
       (product_id, name, name_zh, tagline_zh, canonical_domain, last_seen_at, metadata, representative_raw_item_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb, $7)`,
    [
      productId,
      args.name ?? `${PREFIX}${args.suffix}-name`,
      args.nameZh ?? null,
      args.taglineZh ?? null,
      args.canonicalDomain ?? null,
      args.metadata ? JSON.stringify(args.metadata) : null,
      args.representativeRawItemId ? args.representativeRawItemId.toString() : null,
    ],
  );
  return productId;
}

/** 插一条 raw_item（带 content），返回其 bigint id。 */
async function seedRawItem(content: string | null): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, title, content) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${PREFIX}src`, `${PREFIX}${Math.random().toString(36).slice(2)}`, 'raw title', content],
  );
  return BigInt(rows[0]!.id);
}

async function fetchProductZh(productId: string): Promise<{
  name: string;
  nameZh: string | null;
  taglineZh: string | null;
}> {
  const { rows } = await pool!.query<{
    name: string;
    name_zh: string | null;
    tagline_zh: string | null;
  }>(`SELECT name, name_zh, tagline_zh FROM ai_products WHERE product_id = $1`, [productId]);
  const r = rows[0]!;
  return { name: r.name, nameZh: r.name_zh, taglineZh: r.tagline_zh };
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM push_records WHERE target_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM ai_products WHERE product_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [`${PREFIX}src`]);
}

beforeAll(cleanup);
// digestPendingProducts channel-blind 扫全表候选；per-test 清理本套件造的行，确保各用例间不串扰
// （一个用例 seed 的未中文化产品不会被下一个用例的 digest 调用顺带中文化）。
beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool?.end();
});

describe.skipIf(!canRun)('digestPendingProducts 候选并集 + 中文化（8.2）', () => {
  it('channels 为空 → 直接 return：不下发查询、不调 LLM、产品保持 NULL', async () => {
    const pid = await seedProduct({ suffix: 'empty-ch' });
    const mock = okSummarize();
    await digestPendingProducts(db!, [], undefined, { generateObjectFn: mock });
    expect(mock).not.toHaveBeenCalled();
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBeNull();
  });

  it('未中文化（name_zh IS NULL）的候选产品被中文化：写入 name_zh + tagline_zh', async () => {
    const rawId = await seedRawItem('An open-source coding agent for developers.');
    const pid = await seedProduct({ suffix: 'to-digest', representativeRawItemId: rawId });
    const mock = okSummarize({ name_zh: '编码助手', tagline_zh: '面向开发者的开源编码助手。' });
    // maxAttempts:1 透传给 summarizeProduct，使外部产品的空输出不触发重试、调用数干净。
    await digestPendingProducts(db!, ['telegram'], undefined, {
      generateObjectFn: mock,
      maxAttempts: 1,
    });
    expect(mock).toHaveBeenCalledTimes(1); // 仅本套件 1 个待中文化产品（per-test 清理保证）。
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBe('编码助手');
    expect(after.taglineZh).toBe('面向开发者的开源编码助手。');
  });

  it('已 name_zh 跳过 LLM（幂等）：不重复调用、不覆盖既有中文', async () => {
    const pid = await seedProduct({
      suffix: 'already-zh',
      nameZh: '已有译名',
      taglineZh: '已有简介。',
    });
    const mock = okSummarize({ name_zh: '不应被写入', tagline_zh: '不应被写入。' });
    await digestPendingProducts(db!, ['telegram'], undefined, {
      generateObjectFn: mock,
      maxAttempts: 1,
    });
    // 该产品已 name_zh → 不在 pending 集 → 不调 LLM、中文保持原值（幂等缓存复用）。
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBe('已有译名');
    expect(after.taglineZh).toBe('已有简介。');
    // 本套件该用例无其它待中文化产品（per-test 清理）→ mock 完全不被调用。
    expect(mock).not.toHaveBeenCalled();
  });

  it('占位名 (unnamed product) 不入候选：不调 LLM、保持 NULL（防零信息幻觉译名）', async () => {
    const pid = await seedProduct({ suffix: 'unnamed', name: UNNAMED_PRODUCT_NAME });
    const mock = okSummarize();
    await digestPendingProducts(db!, ['telegram'], undefined, {
      generateObjectFn: mock,
      maxAttempts: 1,
    });
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBeNull();
    // 占位名被 ne(name, UNNAMED_PRODUCT_NAME) 排除 → 该产品绝不被中文化。
    expect(mock).not.toHaveBeenCalled();
  });

  it('merge_conflict 产品不入候选：不调 LLM、保持 NULL', async () => {
    const pid = await seedProduct({
      suffix: 'conflict',
      metadata: { merge_conflict: { conflict_with: ['other'], detected_at: 'now' } },
    });
    const mock = okSummarize();
    await digestPendingProducts(db!, ['telegram'], undefined, {
      generateObjectFn: mock,
      maxAttempts: 1,
    });
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('UNION 覆盖各 channel per-channel 候选：「已推 tg 未推 feishu」产品仍被中文化', async () => {
    // 构造一个已在 telegram success（telegram 候选排除它）但 feishu 从未推（feishu 候选含它）的产品。
    // 若中文化集只取单 channel 候选会漏掉它；候选并集（tg ∪ feishu）覆盖 → 被中文化。
    const pid = await seedProduct({ suffix: 'tg-pushed-fs-not' });
    await pool!.query(
      `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
       VALUES ('product', $1, 'telegram', $2, 'success', now())`,
      [pid, PUSH_DATE_1],
    );
    // 仅传 telegram 时该产品不在 telegram 候选 → 不被中文化（证明单 channel 会漏）。
    const mockTgOnly = okSummarize();
    await digestPendingProducts(db!, ['telegram'], undefined, {
      generateObjectFn: mockTgOnly,
      maxAttempts: 1,
    });
    expect((await fetchProductZh(pid)).nameZh).toBeNull();

    // 传 telegram + feishu 并集 → feishu 候选含它 → 被中文化（并集覆盖 per-channel）。
    const mockUnion = okSummarize({ name_zh: '并集覆盖译名', tagline_zh: '并集覆盖简介。' });
    await digestPendingProducts(db!, ['telegram', 'feishu'], undefined, {
      generateObjectFn: mockUnion,
      maxAttempts: 1,
    });
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBe('并集覆盖译名');
    expect(after.taglineZh).toBe('并集覆盖简介。');
  });

  it('representative_raw_item_id 为 NULL（LEFT JOIN 非 INNER）：产品仍被中文化、不被静默挤出', async () => {
    // LEFT JOIN raw_items：representative_raw_item_id 为 NULL/悬空的产品仍保留（content=NULL、
    // 仅凭 name 中文化）。若实现误用 INNER JOIN 会把该产品静默挤出 → 永英文；此处验证它被写入中文。
    const pid = await seedProduct({ suffix: 'no-raw', representativeRawItemId: null });
    const mock = okSummarize({ name_zh: '无正文译名', tagline_zh: '无正文简介。' });
    await digestPendingProducts(db!, ['telegram'], undefined, {
      generateObjectFn: mock,
      maxAttempts: 1,
    });
    const after = await fetchProductZh(pid);
    expect(after.nameZh).toBe('无正文译名'); // 未被 INNER JOIN 挤出 → 正常中文化。
  });
});

describe.skipIf(!canRun)('selectProductCandidates 读中文列 + 回退映射（8.3）', () => {
  it('中文化产品：representativeTitle=name_zh、headlineZh=tagline_zh', async () => {
    const pid = await seedProduct({
      suffix: 'mapped-zh',
      name: `${PREFIX}EnglishName`,
      nameZh: '中文译名',
      taglineZh: '中文要点简介。',
    });
    const candidates = await selectProductCandidates('telegram', db!);
    const c = candidates.find((x) => x.eventId === pid)!;
    expect(c).toBeTruthy();
    expect(c.representativeTitle).toBe('中文译名'); // 中文译名优先。
    expect(c.headlineZh).toBe('中文要点简介。'); // headlineZh 承载 tagline_zh。
    expect(c.summaryZh).toBeNull(); // 产品无 summary_zh，仍 null。
  });

  it('未中文化产品：回退英文 name、headlineZh=null（无要点行）', async () => {
    const pid = await seedProduct({
      suffix: 'mapped-en',
      name: `${PREFIX}OnlyEnglish`,
      nameZh: null,
      taglineZh: null,
    });
    const candidates = await selectProductCandidates('telegram', db!);
    const c = candidates.find((x) => x.eventId === pid)!;
    expect(c.representativeTitle).toBe(`${PREFIX}OnlyEnglish`); // 回退英文名。
    expect(c.headlineZh).toBeNull(); // 无中文简介 → 无要点行。
    expect(c.summaryZh).toBeNull();
  });

  it('选品条件不变：中文化不影响 merge_conflict 排除', async () => {
    const pid = await seedProduct({
      suffix: 'zh-conflict',
      nameZh: '有中文但冲突',
      taglineZh: '冲突简介。',
      metadata: { merge_conflict: { conflict_with: ['x'], detected_at: 'now' } },
    });
    const candidates = await selectProductCandidates('telegram', db!);
    // merge_conflict 排除口径一字不改：即便有中文列，冲突产品仍不入候选。
    expect(candidates.map((c) => c.eventId)).not.toContain(pid);
  });
});

describe.skipIf(!canRun)('digestPendingProducts 失败语义分层（8.7）', () => {
  it('单产品业务失败（ProductDigestFailureError）：保持 NULL 继续下一个、整步不抛', async () => {
    const pidFail = await seedProduct({ suffix: 'biz-fail' });
    const pidOk = await seedProduct({ suffix: 'biz-ok' });
    // generateObjectFn 层 mock：产品名在 prompt 里（buildPrompt 写「产品名：<name>」）。
    // 失败产品返回空 name_zh（Zod 不过 → summarizeProduct 降级抛 ProductDigestFailureError 业务失败信号）。
    const mock = vi.fn().mockImplementation(async (args: { prompt: string }) => {
      if (args.prompt.includes(`${PREFIX}biz-fail-name`)) {
        return { object: { name_zh: '', tagline_zh: '' } };
      }
      return { object: { name_zh: '成功译名', tagline_zh: '成功简介。' } };
    });
    const alert = vi.fn();
    // 整步不抛（永不向上抛）。maxAttempts:1 使失败产品不重试、调用数干净。
    await expect(
      digestPendingProducts(db!, ['telegram'], alert, {
        generateObjectFn: mock,
        maxAttempts: 1,
        logError: () => {},
      }),
    ).resolves.toBeUndefined();
    // 业务失败产品保持 NULL（渲染回退英文）；另一产品照常中文化（继续下一个）。
    expect((await fetchProductZh(pidFail)).nameZh).toBeNull();
    expect((await fetchProductZh(pidOk)).nameZh).toBe('成功译名');
  });

  it('单产品业务失败规模未超阈：整步不抛、不告警（1/2 失败，绝对阈 3、比例阈 0.5）', async () => {
    await seedProduct({ suffix: 'rate-fail' });
    await seedProduct({ suffix: 'rate-ok' });
    const mock = vi.fn().mockImplementation(async (args: { prompt: string }) => {
      if (args.prompt.includes(`${PREFIX}rate-fail-name`)) {
        return { object: { name_zh: '', tagline_zh: '' } }; // 业务失败（降级）。
      }
      return { object: { name_zh: 'ok', tagline_zh: 'ok。' } };
    });
    const alert = vi.fn();
    await digestPendingProducts(db!, ['telegram'], alert, {
      generateObjectFn: mock,
      maxAttempts: 1,
      logError: () => {},
    });
    // 失败率 1/2 = 0.5（非严格 > 0.5）且失败数 1 < 3 → 不告警。
    expect(alert).not.toHaveBeenCalled();
  });

  it('系统级异常（updateProductZh 写失败，非 ProductDigestFailureError）：整步不抛但触发 alert（失败规模超阈）', async () => {
    // 造 3 个待中文化产品，summarizeProduct 全成功，但用一个会让 updateProductZh 全失败的 db 句柄
    // （update 抛非 ProductDigestFailureError 系统异常）→ 失败数 3 ≥ 绝对阈 → 整步不抛、单独告警。
    await seedProduct({ suffix: 'sys-1' });
    await seedProduct({ suffix: 'sys-2' });
    await seedProduct({ suffix: 'sys-3' });
    const mock = okSummarize();
    const alert = vi.fn();

    // 包装真实 db：候选/pending 查询走真库（读真实候选），但 update().set().where() 抛系统异常。
    const failingDb = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return () => ({
            set: () => ({
              where: () => {
                throw new Error('DB write failed (system-level)');
              },
            }),
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    await expect(
      digestPendingProducts(failingDb!, ['telegram'], alert, {
        generateObjectFn: mock,
        maxAttempts: 1,
        logError: () => {},
      }),
    ).resolves.toBeUndefined(); // 系统异常整步仍不向上抛（保护新闻链）。
    // 失败规模异常（≥3 或 >50%）→ 单独告警（系统故障可观测、不静默黑洞）。
    expect(alert).toHaveBeenCalled();
    const alertMsgs = alert.mock.calls.map((c) => String(c[0]));
    expect(alertMsgs.some((m) => m.includes('产品中文化失败规模异常'))).toBe(true);
  });

  it('候选并集查询失败（非 ProductDigestFailureError）：整步不抛但告警、跳过该 channel', async () => {
    await seedProduct({ suffix: 'cand-fail' });
    const mock = okSummarize();
    const alert = vi.fn();
    // 包装真实 db：select 抛错（模拟候选查询 DB 故障）。
    const failingSelectDb = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          return () => {
            throw new Error('candidate select failed (system-level)');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    await expect(
      digestPendingProducts(failingSelectDb!, ['telegram'], alert, {
        generateObjectFn: mock,
        maxAttempts: 1,
        logError: () => {},
      }),
    ).resolves.toBeUndefined();
    // 候选并集收集失败：告警（系统故障可观测）、不调 LLM（并集空 → 直接 return）。
    expect(alert).toHaveBeenCalled();
    expect(mock).not.toHaveBeenCalled();
  });
});

describe.skipIf(!canRun)('assertProductZhColumns 部署假绿守卫（8.8）', () => {
  it('中文列存在（已迁移库）→ 探针通过、不抛', async () => {
    await expect(assertProductZhColumns(db!)).resolves.toBeUndefined();
  });

  it('探针失败（缺列 / DB 故障）→ fail-fast 抛明确错误，不被静默吞', async () => {
    // 用 execute 抛错的 db 桩模拟「列不存在 / 探针失败」：assertProductZhColumns 须 fail-fast 抛错。
    const brokenDb = {
      execute: async () => {
        throw new Error('column "name_zh" does not exist');
      },
    } as never;
    await expect(assertProductZhColumns(brokenDb)).rejects.toThrow(
      /ai_products 缺少中文展示列|迁移/,
    );
  });
});
