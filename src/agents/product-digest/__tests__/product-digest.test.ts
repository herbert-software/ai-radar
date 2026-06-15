/**
 * 产品中文化 Agent 单元测试（task 8.1）——纯 mock LLM，不依赖真实 key、不需 DB。
 *
 * 覆盖关键不变量（与 events digest 同规格 Agent 内核）：
 * 1. productDigestOutputSchema 校验通过路径接受含非空 name_zh + tagline_zh 的输出。
 * 2. 空串 / 缺字段 / 仅空白 / 超长（NAME_ZH_MAX / PRODUCT_TAGLINE_MAX）/ mojibake 被 Zod 挡掉。
 * 3. summarizeProduct：成功返回经校验结构；校验不过（空/超长/mojibake）有限重试 → 耗尽降级抛
 *    ProductDigestFailureError（证明绝不返回未校验或半截输出）。
 * 4. persistence updateProductZh：UPDATE set **仅含** name_zh + tagline_zh（不碰塌缩/合并/状态列）。
 *
 * summarizeProduct 经 generateObjectFn 注入 mock；persistence 经 db stub 断言 set 内容。
 * 落库真实往返（连真库不覆盖塌缩列）由 *.integration.test.ts 实跑 DB（task 8.2）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NAME_ZH_MAX, PRODUCT_TAGLINE_MAX } from '../schema.js';

// index.js / persistence.js 经 import 链间接 import env（启动期校验，缺关键变量即 throw）。
// 单元测试不依赖真实 key，注入占位 env 后再动态 import，使本套件无需真实凭据、无需 DB。
let summarizeProduct: typeof import('../index.js').summarizeProduct;
let ProductDigestFailureError: typeof import('../index.js').ProductDigestFailureError;
let productDigestOutputSchema: typeof import('../index.js').productDigestOutputSchema;
let updateProductZh: typeof import('../persistence.js').updateProductZh;

beforeAll(async () => {
  // 用 ||= 兼容空串 env（已定义但为空），否则 env.ts 的 .min(1)/.url() 会让本纯单元套件
  // 在 import 期 throw（假红）。
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  const idx = await import('../index.js');
  summarizeProduct = idx.summarizeProduct;
  ProductDigestFailureError = idx.ProductDigestFailureError;
  productDigestOutputSchema = idx.productDigestOutputSchema;
  const persistence = await import('../persistence.js');
  updateProductZh = persistence.updateProductZh;
});

const VALID_OUTPUT = {
  name_zh: '某编码助手',
  tagline_zh: '一款面向开发者的开源编码助手，支持多文件编辑与命令行集成。',
};

// 上游双重编码乱码样本（U+0080–U+00BF 续字节成片出现，命中 mojibake 判据）。
const MOJIBAKE = 'æ¬ææ é¢ä¸ºNotes on DeepSeek';

describe('productDigestOutputSchema', () => {
  it('接受含非空 name_zh + tagline_zh 的合法输出', () => {
    expect(productDigestOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);
  });

  it('拒绝空串 name_zh（半截输出）', () => {
    expect(
      productDigestOutputSchema.safeParse({ name_zh: '', tagline_zh: VALID_OUTPUT.tagline_zh })
        .success,
    ).toBe(false);
  });

  it('拒绝仅空白 name_zh', () => {
    expect(
      productDigestOutputSchema.safeParse({ name_zh: '   ', tagline_zh: VALID_OUTPUT.tagline_zh })
        .success,
    ).toBe(false);
  });

  it('拒绝缺 name_zh 字段', () => {
    expect(
      productDigestOutputSchema.safeParse({ tagline_zh: VALID_OUTPUT.tagline_zh }).success,
    ).toBe(false);
  });

  it(`拒绝超长 name_zh（>${NAME_ZH_MAX} 字）`, () => {
    expect(
      productDigestOutputSchema.safeParse({
        name_zh: '字'.repeat(NAME_ZH_MAX + 1),
        tagline_zh: VALID_OUTPUT.tagline_zh,
      }).success,
    ).toBe(false);
  });

  it(`接受恰好 ${NAME_ZH_MAX} 字的 name_zh（边界）`, () => {
    expect(
      productDigestOutputSchema.safeParse({
        name_zh: '字'.repeat(NAME_ZH_MAX),
        tagline_zh: VALID_OUTPUT.tagline_zh,
      }).success,
    ).toBe(true);
  });

  it('拒绝 mojibake name_zh（上游双重编码乱码）', () => {
    expect(
      productDigestOutputSchema.safeParse({
        name_zh: MOJIBAKE,
        tagline_zh: VALID_OUTPUT.tagline_zh,
      }).success,
    ).toBe(false);
  });

  it('拒绝空串 tagline_zh（半截输出）', () => {
    expect(
      productDigestOutputSchema.safeParse({ name_zh: VALID_OUTPUT.name_zh, tagline_zh: '' })
        .success,
    ).toBe(false);
  });

  it('拒绝仅空白 tagline_zh', () => {
    expect(
      productDigestOutputSchema.safeParse({ name_zh: VALID_OUTPUT.name_zh, tagline_zh: '   ' })
        .success,
    ).toBe(false);
  });

  it('拒绝缺 tagline_zh 字段', () => {
    expect(
      productDigestOutputSchema.safeParse({ name_zh: VALID_OUTPUT.name_zh }).success,
    ).toBe(false);
  });

  it(`拒绝超长 tagline_zh（>${PRODUCT_TAGLINE_MAX} 字）`, () => {
    expect(
      productDigestOutputSchema.safeParse({
        name_zh: VALID_OUTPUT.name_zh,
        tagline_zh: '字'.repeat(PRODUCT_TAGLINE_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it(`接受恰好 ${PRODUCT_TAGLINE_MAX} 字的 tagline_zh（边界）`, () => {
    expect(
      productDigestOutputSchema.safeParse({
        name_zh: VALID_OUTPUT.name_zh,
        tagline_zh: '字'.repeat(PRODUCT_TAGLINE_MAX),
      }).success,
    ).toBe(true);
  });

  it('拒绝 mojibake tagline_zh（上游双重编码乱码）', () => {
    expect(
      productDigestOutputSchema.safeParse({
        name_zh: VALID_OUTPUT.name_zh,
        tagline_zh: MOJIBAKE,
      }).success,
    ).toBe(false);
  });
});

describe('summarizeProduct（mock generateObject）', () => {
  it('校验通过路径：返回经 Zod 校验的结构（name_zh + tagline_zh）', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const result = await summarizeProduct(
      { name: 'SomeCodingAgent', content: 'An open-source coding agent.' },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('content 缺失（如 Show HN 恒 null）：仅凭 name 仍调用并返回校验结果', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const result = await summarizeProduct(
      { name: 'ShowHNTool', content: null },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回空 name_zh：有限重试后降级抛 ProductDigestFailureError，不返回半截输出', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { name_zh: '', tagline_zh: VALID_OUTPUT.tagline_zh } });
    const logError = vi.fn();
    await expect(
      summarizeProduct(
        { name: 'X' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(ProductDigestFailureError);
    // 有限重试用尽：调用次数 = maxAttempts；每次失败都记日志（非静默）。
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('LLM 返回超长 tagline_zh：走 Zod 失败路径重试，耗尽后降级，不返回超长内容', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({
      object: { name_zh: VALID_OUTPUT.name_zh, tagline_zh: '字'.repeat(PRODUCT_TAGLINE_MAX + 1) },
    });
    const logError = vi.fn();
    await expect(
      summarizeProduct({ name: 'X' }, { generateObjectFn, maxAttempts: 2, logError }),
    ).rejects.toBeInstanceOf(ProductDigestFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('LLM 返回 mojibake name_zh：走 Zod 失败路径重试，耗尽后降级，不返回乱码', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { name_zh: MOJIBAKE, tagline_zh: VALID_OUTPUT.tagline_zh } });
    const logError = vi.fn();
    await expect(
      summarizeProduct({ name: 'X' }, { generateObjectFn, maxAttempts: 2, logError }),
    ).rejects.toBeInstanceOf(ProductDigestFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('generateObject 抛错：记日志并重试，最终降级抛 ProductDigestFailureError（含 attempts）', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    const logError = vi.fn();
    const err = await summarizeProduct(
      { name: 'X' },
      { generateObjectFn, maxAttempts: 3, logError },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProductDigestFailureError);
    expect((err as InstanceType<typeof ProductDigestFailureError>).attempts).toBe(3);
    expect(generateObjectFn).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it('首次失败后重试成功：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ object: VALID_OUTPUT });
    const result = await summarizeProduct(
      { name: 'X' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });

  it('首次 mojibake 后重试返回干净输出：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValueOnce({ object: { name_zh: MOJIBAKE, tagline_zh: MOJIBAKE } })
      .mockResolvedValueOnce({ object: VALID_OUTPUT });
    const result = await summarizeProduct(
      { name: 'X' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });
});

describe('updateProductZh：UPDATE set 仅含中文列（mock db）', () => {
  /** 制造一个最小 db stub，记录 update().set().where() 调用参数。 */
  function makeDbStub() {
    const setSpy = vi.fn();
    const whereSpy = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({
      set: (...setArgs: unknown[]) => {
        setSpy(...setArgs);
        return { where: whereSpy };
      },
    }));
    return { dbStub: { update } as never, setSpy, whereSpy, update };
  }

  it('落库 UPDATE：set 仅含 nameZh + taglineZh，绝不触碰塌缩/合并/状态列', async () => {
    const { dbStub, setSpy, update } = makeDbStub();
    await updateProductZh(dbStub, 'prod-1', VALID_OUTPUT.name_zh, VALID_OUTPUT.tagline_zh);
    expect(update).toHaveBeenCalledTimes(1);
    // set 仅含 nameZh + taglineZh，绝不含 name / canonical_domain / metadata / merge_conflict 等。
    expect(setSpy).toHaveBeenCalledWith({
      nameZh: VALID_OUTPUT.name_zh,
      taglineZh: VALID_OUTPUT.tagline_zh,
    });
    const setArg = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(setArg).sort()).toEqual(['nameZh', 'taglineZh']);
  });
});
