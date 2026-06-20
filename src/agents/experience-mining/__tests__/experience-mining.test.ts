/**
 * 经验提炼 Agent 单元测试（任务 3.3）——纯 mock LLM，不依赖真实 key、不触网、不需 DB。
 *
 * 覆盖（spec「经验提炼 Agent 结构化输出」两场景）：
 * 1. 合规 JSON 通过 Zod 校验 → 返回有效卡片对象（含 long_term_value）。
 * 2. 缺字段 → 重试后仍不合规 → 降级抛 ExperienceMiningFailureError，不返回脏卡片。
 * 3. long_term_value 越界（>100 / <0 / 小数）→ 同样降级，不返回越界脏卡片。
 * 4. schema 不含 source_url（来源是确定性 canonical_source_url，不由 LLM 产出）。
 * 5. 提炼前按 EXPERIENCE_TEXT_MAX_CHARS 截断超长正文（断言 prompt 不含截断点之后的文本）。
 * 6. LLM 调用抛错 → 记日志并重试，最终降级；首次失败后重试成功 → 返回校验结果。
 *
 * 关键守卫：所有用例注入 generateObjectFn mock，绝不触达默认真实 LLM 路径
 * （llm-client.ts 的 VITEST 守卫亦会兜底，但此处显式注入）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// mineExperience 经 ../index.js 间接 import env（启动期校验，缺关键变量即 throw）。
// 单元测试不依赖真实 key，注入占位 env（仅需非空字符串/合法 URL）后再动态 import，
// 使本套件无需真实凭据、无需 DB 即可跑（镜像 value-judge.test.ts）。
let mineExperience: typeof import('../index.js').mineExperience;
let ExperienceMiningFailureError: typeof import('../index.js').ExperienceMiningFailureError;
let experienceCardSchema: typeof import('../schema.js').experienceCardSchema;

// 捕获原始 env，afterAll 还原——防 beforeAll 设的占位（尤其 DATABASE_URL/REDIS_URL）泄漏到
// 同 worker 后续测试，使其 DB-gated `skipIf(!databaseUrl)` 误判为可跑（test-order leakage）。
const ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_BASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

afterAll(() => {
  for (const k of ENV_KEYS) {
    const orig = ORIGINAL_ENV.get(k);
    if (orig === undefined) delete process.env[k];
    else process.env[k] = orig;
  }
});

beforeAll(async () => {
  // 用 ||= 而非 ??=：空串 env（已定义但为空）也覆盖为占位，否则 env.ts 的 .min(1) 会让本
  // 「纯单元、无需 DB」套件在 import 期 throw（假红）。
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  const mod = await import('../index.js');
  mineExperience = mod.mineExperience;
  ExperienceMiningFailureError = mod.ExperienceMiningFailureError;
  experienceCardSchema = (await import('../schema.js')).experienceCardSchema;
});

const VALID_CARD = {
  scenario: '用 AI Coding 工具重构遗留代码',
  tools: ['Cursor', 'Claude'],
  techniques: '先让模型写测试再小步重构，逐文件 review diff',
  applicability: '适合有测试覆盖、模块边界清晰的中型仓库',
  long_term_value: 82,
  headline_zh: '小步重构 + AI 先写测试，遗留代码也能稳改',
  summary_zh: '通过让 AI 先补测试再重构，可显著降低改动风险。',
};

describe('experienceCardSchema', () => {
  it('接受合法卡片', () => {
    expect(experienceCardSchema.safeParse(VALID_CARD).success).toBe(true);
  });

  it('接受空 tools 数组（卡片可能不点名具体工具）', () => {
    const card = { ...VALID_CARD, tools: [] as string[] };
    expect(experienceCardSchema.safeParse(card).success).toBe(true);
  });

  it('拒绝 long_term_value 越界（>100）', () => {
    const bad = { ...VALID_CARD, long_term_value: 150 };
    expect(experienceCardSchema.safeParse(bad).success).toBe(false);
  });

  it('拒绝 long_term_value 越界（<0）', () => {
    const bad = { ...VALID_CARD, long_term_value: -1 };
    expect(experienceCardSchema.safeParse(bad).success).toBe(false);
  });

  it('拒绝 long_term_value 小数（非整数）', () => {
    const bad = { ...VALID_CARD, long_term_value: 82.5 };
    expect(experienceCardSchema.safeParse(bad).success).toBe(false);
  });

  it('拒绝缺字段', () => {
    const missing: Record<string, unknown> = { ...VALID_CARD };
    delete missing.scenario;
    expect(experienceCardSchema.safeParse(missing).success).toBe(false);
  });

  it('schema 不含 source_url（来源是确定性 canonical_source_url，不由 LLM 产出）', () => {
    // 即便 LLM 多塞 source_url，校验后的卡片亦不含该字段（且不串入其他字段）。
    const withUrl = { ...VALID_CARD, source_url: 'https://x.test/leak' };
    const parsed = experienceCardSchema.parse(withUrl);
    expect(parsed).not.toHaveProperty('source_url');
  });
});

describe('mineExperience（mock generateObject）', () => {
  it('合规 JSON：通过校验返回有效卡片对象', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_CARD });
    const result = await mineExperience(
      { title: '一条经验帖', content: '正文……' },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual(VALID_CARD);
    expect(result).not.toHaveProperty('source_url');
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('缺字段：有限重试后降级抛 ExperienceMiningFailureError，不返回脏卡片', async () => {
    const broken = { ...VALID_CARD } as Record<string, unknown>;
    delete broken.summary_zh;
    const generateObjectFn = vi.fn().mockResolvedValue({ object: broken });
    const logError = vi.fn();
    await expect(
      mineExperience(
        { title: 't', content: 'c' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(ExperienceMiningFailureError);
    // 有限重试用尽：调用次数 = maxAttempts；每次失败都记日志（非静默）。
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('long_term_value 越界（>100）：重试后仍不合规 → 降级不返回越界脏卡片', async () => {
    const overscored = { ...VALID_CARD, long_term_value: 150 };
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: overscored });
    const logError = vi.fn();
    await expect(
      mineExperience(
        { title: 't' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(ExperienceMiningFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('generateObject 抛错：记日志并重试，最终降级', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValue(new Error('LLM down'));
    const logError = vi.fn();
    await expect(
      mineExperience(
        { title: 't' },
        { generateObjectFn, maxAttempts: 3, logError },
      ),
    ).rejects.toBeInstanceOf(ExperienceMiningFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it('首次失败后重试成功：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ object: VALID_CARD });
    const result = await mineExperience(
      { title: 't' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_CARD);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });

  it('提炼前按 maxChars 截断超长正文：prompt 不含截断点之后的文本', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_CARD });
    // 正文 = 6 个 'a' + 唯一标记 'TAIL_MARKER'；maxChars=6 应只保留前 6 个 'a'、截掉标记。
    const content = 'aaaaaa' + 'TAIL_MARKER';
    await mineExperience(
      { title: 't', content },
      { generateObjectFn, maxChars: 6, logError: () => {} },
    );
    const promptArg = (generateObjectFn.mock.calls[0]![0] as { prompt: string })
      .prompt;
    expect(promptArg).toContain('aaaaaa');
    expect(promptArg).not.toContain('TAIL_MARKER');
  });
});
