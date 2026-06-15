/**
 * 知识摘要 Agent 单元测试（组 E 任务 5.1）——纯 mock LLM，不依赖真实 key / DB。
 *
 * 覆盖 spec「知识摘要 Agent 产出入库元数据」/「校验不过的输出被跳过不入库」不变量：
 * 1. 合法输出经 Zod 校验通过、原样返回。
 * 2. **long_term_value 越界（200 / 负数 / 小数）→ 校验不过 → 重试耗尽降级抛错**（防越界绕过准入闸）。
 * 3. 缺字段 / 类型错 → 重试后降级抛 KbIngestionAgentFailureError，不返回未校验数据（不污染 KB）。
 * 4. event_date 非 YYYY-MM-DD → 校验不过。
 * 5. 首次失败后重试成功 → 返回校验结果。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let generateKbMetadata: typeof import('../index.js').generateKbMetadata;
let KbIngestionAgentFailureError: typeof import('../index.js').KbIngestionAgentFailureError;
let kbIngestionMetadataSchema: typeof import('../index.js').kbIngestionMetadataSchema;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  const mod = await import('../index.js');
  generateKbMetadata = mod.generateKbMetadata;
  KbIngestionAgentFailureError = mod.KbIngestionAgentFailureError;
  kbIngestionMetadataSchema = mod.kbIngestionMetadataSchema;
});

const VALID_META = {
  kb_title: '某知识标题',
  summary_zh: '某中文摘要',
  tags: ['AI', 'LLM'],
  entities: ['OpenAI'],
  source_urls: ['https://example.com/a'],
  event_date: '2026-06-15',
  long_term_value: 78,
};

describe('kbIngestionMetadataSchema', () => {
  it('接受合法输出', () => {
    expect(kbIngestionMetadataSchema.safeParse(VALID_META).success).toBe(true);
  });

  it('拒绝 long_term_value 越界（>100）—— 防绕过准入闸', () => {
    expect(
      kbIngestionMetadataSchema.safeParse({ ...VALID_META, long_term_value: 200 }).success,
    ).toBe(false);
  });

  it('拒绝 long_term_value 负数', () => {
    expect(
      kbIngestionMetadataSchema.safeParse({ ...VALID_META, long_term_value: -5 }).success,
    ).toBe(false);
  });

  it('拒绝 long_term_value 小数（非整数）', () => {
    expect(
      kbIngestionMetadataSchema.safeParse({ ...VALID_META, long_term_value: 72.5 }).success,
    ).toBe(false);
  });

  it('拒绝 event_date 非 YYYY-MM-DD', () => {
    expect(
      kbIngestionMetadataSchema.safeParse({ ...VALID_META, event_date: '2026/06/15' }).success,
    ).toBe(false);
  });

  it('拒绝缺字段', () => {
    const missing: Record<string, unknown> = { ...VALID_META };
    delete missing.kb_title;
    expect(kbIngestionMetadataSchema.safeParse(missing).success).toBe(false);
  });
});

describe('generateKbMetadata（mock generateObject）', () => {
  it('校验通过路径：返回经 Zod 校验的结构', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_META });
    const result = await generateKbMetadata(
      { representativeTitle: 'seed title' },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual(VALID_META);
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('long_term_value 越界（200）：重试耗尽降级抛错，不返回未校验数据', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { ...VALID_META, long_term_value: 200 } });
    const logError = vi.fn();
    await expect(
      generateKbMetadata(
        { representativeTitle: 'seed title' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(KbIngestionAgentFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('LLM 返回不符 schema：有限重试后降级抛 KbIngestionAgentFailureError', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { kb_title: 123 } });
    const logError = vi.fn();
    await expect(
      generateKbMetadata(
        { representativeTitle: 'seed title' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(KbIngestionAgentFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });

  it('generateObject 抛错：记录日志并重试，最终降级', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    const logError = vi.fn();
    await expect(
      generateKbMetadata(
        { representativeTitle: 'seed title' },
        { generateObjectFn, maxAttempts: 3, logError },
      ),
    ).rejects.toBeInstanceOf(KbIngestionAgentFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it('首次失败后重试成功：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ object: VALID_META });
    const result = await generateKbMetadata(
      { representativeTitle: 'seed title' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_META);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });
});
