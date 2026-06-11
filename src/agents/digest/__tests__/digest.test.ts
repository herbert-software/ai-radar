/**
 * 中文摘要 Agent 单元测试（任务 7.3）——纯 mock LLM，不依赖真实 key、不需 DB。
 *
 * 覆盖关键不变量：
 * 1. schema 校验通过路径返回含非空 summary_zh 的结构。
 * 2. 空串 / 缺字段 summary_zh 被 Zod 挡掉 → 触发重试 → 降级抛 DigestFailureError
 *    （证明绝不返回未校验或半截输出）。
 * 3. 降级编排（digestEvent）：摘要失败时回退 representative_title / 兜底 canonical_url /
 *    剔除，且**绝不调用** UPDATE 写 summary_zh（不污染推送、不写未校验内容）。
 *
 * digestEvent 的成功落库往返（真实 UPDATE summary_zh）由 *.integration.test.ts 实跑 DB。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { digestOutputSchema, HEADLINE_MAX } from '../schema.js';

// index.js / persistence.js 经 import 链间接 import env（启动期校验，缺关键变量即 throw）。
// 单元测试不依赖真实 key，注入占位 env 后再动态 import，使本套件无需真实凭据、无需 DB。
let summarizeEvent: typeof import('../index.js').summarizeEvent;
let DigestFailureError: typeof import('../index.js').DigestFailureError;
let digestEvent: typeof import('../persistence.js').digestEvent;

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
  summarizeEvent = idx.summarizeEvent;
  DigestFailureError = idx.DigestFailureError;
  const persistence = await import('../persistence.js');
  digestEvent = persistence.digestEvent;
});

const VALID_OUTPUT = {
  summary_zh: '某开源编码 Agent 发布新版本，支持多文件编辑，对开发者集成有直接影响。',
  headline_zh: '某开源编码 Agent 发布新版本，支持多文件编辑，便于开发者集成。',
};

describe('digestOutputSchema', () => {
  it('接受含非空 summary_zh 的合法输出', () => {
    expect(digestOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);
  });

  it('拒绝空串 summary_zh（半截输出）', () => {
    expect(digestOutputSchema.safeParse({ summary_zh: '' }).success).toBe(false);
  });

  it('拒绝仅空白 summary_zh', () => {
    expect(digestOutputSchema.safeParse({ summary_zh: '   ' }).success).toBe(false);
  });

  it('拒绝缺 summary_zh 字段', () => {
    expect(digestOutputSchema.safeParse({}).success).toBe(false);
  });

  it('拒绝超长 summary_zh（>1000 字会撑爆 Telegram 单条消息上限致永不送达）', () => {
    expect(
      digestOutputSchema.safeParse({ summary_zh: '字'.repeat(1001) }).success,
    ).toBe(false);
  });

  it('拒绝 mojibake summary_zh（上游双重编码乱码）', () => {
    expect(
      digestOutputSchema.safeParse({ summary_zh: 'æ¬ææ é¢ä¸ºNotes on DeepSeek' })
        .success,
    ).toBe(false);
  });

  it('接受含合法 headline_zh 的输出（透传保真）', () => {
    expect(digestOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);
    const parsed = digestOutputSchema.parse(VALID_OUTPUT);
    expect(parsed.headline_zh).toBe(VALID_OUTPUT.headline_zh);
  });

  it('拒绝缺 headline_zh 字段', () => {
    expect(
      digestOutputSchema.safeParse({ summary_zh: VALID_OUTPUT.summary_zh }).success,
    ).toBe(false);
  });

  it('拒绝空串 headline_zh', () => {
    expect(
      digestOutputSchema.safeParse({
        summary_zh: VALID_OUTPUT.summary_zh,
        headline_zh: '',
      }).success,
    ).toBe(false);
  });

  it('拒绝仅空白 headline_zh', () => {
    expect(
      digestOutputSchema.safeParse({
        summary_zh: VALID_OUTPUT.summary_zh,
        headline_zh: '   ',
      }).success,
    ).toBe(false);
  });

  it(`拒绝超长 headline_zh（>${HEADLINE_MAX} 字）`, () => {
    expect(
      digestOutputSchema.safeParse({
        summary_zh: VALID_OUTPUT.summary_zh,
        headline_zh: '字'.repeat(HEADLINE_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it(`接受恰好 ${HEADLINE_MAX} 字的 headline_zh（边界）`, () => {
    expect(
      digestOutputSchema.safeParse({
        summary_zh: VALID_OUTPUT.summary_zh,
        headline_zh: '字'.repeat(HEADLINE_MAX),
      }).success,
    ).toBe(true);
  });

  it('拒绝 mojibake headline_zh（上游双重编码乱码）', () => {
    expect(
      digestOutputSchema.safeParse({
        summary_zh: VALID_OUTPUT.summary_zh,
        headline_zh: 'æ¬ææ é¢ä¸ºNotes on DeepSeek',
      }).success,
    ).toBe(false);
  });
});

describe('summarizeEvent（mock generateObject）', () => {
  it('校验通过路径：返回经 Zod 校验的结构', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const result = await summarizeEvent(
      { title: '某事件标题' },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回空 summary_zh：有限重试后降级抛 DigestFailureError，不返回半截输出', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { summary_zh: '' } });
    const logError = vi.fn();
    await expect(
      summarizeEvent(
        { title: '某事件标题' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(DigestFailureError);
    // 有限重试用尽：调用次数 = maxAttempts；每次失败都记日志（非静默）。
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('generateObject 抛错：记日志并重试，最终降级', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    const logError = vi.fn();
    await expect(
      summarizeEvent(
        { title: '某事件标题' },
        { generateObjectFn, maxAttempts: 3, logError },
      ),
    ).rejects.toBeInstanceOf(DigestFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it('LLM 返回 mojibake summary_zh：走 Zod 失败路径重试，耗尽后降级，不返回乱码', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { summary_zh: 'æ¬ææ é¢ä¸ºNotes on DeepSeek' } });
    const logError = vi.fn();
    await expect(
      summarizeEvent(
        { title: '某事件标题' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(DigestFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('首次 mojibake 后重试返回干净摘要：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValueOnce({ object: { summary_zh: 'æ¬ææ é¢ä¸ºmojibake' } })
      .mockResolvedValueOnce({ object: VALID_OUTPUT });
    const result = await summarizeEvent(
      { title: '某事件标题' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });

  it('首次失败后重试成功：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ object: VALID_OUTPUT });
    const result = await summarizeEvent(
      { title: '某事件标题' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });
});

describe('digestEvent 降级不污染推送（mock generateObject + mock db）', () => {
  /** 制造一个最小 db stub，记录 update().set().where() 是否被调用。 */
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

  it('摘要成功：UPDATE 仅写 summary_zh + headline_zh，返回含 headlineZh 的 summarized', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const { dbStub, setSpy, update } = makeDbStub();
    const outcome = await digestEvent(
      { eventId: 'evt-1', representativeTitle: '代表标题', canonicalUrl: null },
      { generateObjectFn, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({
      eventId: 'evt-1',
      status: 'summarized',
      summaryZh: VALID_OUTPUT.summary_zh,
      headlineZh: VALID_OUTPUT.headline_zh,
      degraded: false,
    });
    expect(update).toHaveBeenCalledTimes(1);
    // set 仅含 summary_zh + headline_zh，绝不含 representative_title / *_score 等身份/评分列。
    expect(setSpy).toHaveBeenCalledWith({
      summaryZh: VALID_OUTPUT.summary_zh,
      headlineZh: VALID_OUTPUT.headline_zh,
    });
  });

  it('摘要失败 + representative_title 可用：回退 fallback，绝不调用 UPDATE（不写未校验内容）', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { summary_zh: '' } });
    const { dbStub, update } = makeDbStub();
    const outcome = await digestEvent(
      { eventId: 'evt-2', representativeTitle: '可回退的代表标题', canonicalUrl: 'https://e.com/a' },
      { generateObjectFn, maxAttempts: 2, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({
      eventId: 'evt-2',
      status: 'fallback',
      fallbackText: '可回退的代表标题',
      degraded: true,
    });
    // 关键：降级路径绝不写 summary_zh。
    expect(update).not.toHaveBeenCalled();
  });

  it('摘要失败 + 标题空串但有 canonical_url：回退兜底到 canonical_url，不写库', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('down'));
    const { dbStub, update } = makeDbStub();
    const outcome = await digestEvent(
      { eventId: 'evt-3', representativeTitle: '   ', canonicalUrl: 'https://e.com/x' },
      { generateObjectFn, maxAttempts: 2, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({
      eventId: 'evt-3',
      status: 'fallback',
      fallbackText: 'https://e.com/x',
      degraded: true,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('摘要失败 + 标题空 + 无 URL：剔除该 event（dropped），不写库', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('down'));
    const { dbStub, update } = makeDbStub();
    const outcome = await digestEvent(
      { eventId: 'evt-4', representativeTitle: '', canonicalUrl: null },
      { generateObjectFn, maxAttempts: 2, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({ eventId: 'evt-4', status: 'dropped', degraded: true });
    expect(update).not.toHaveBeenCalled();
  });

  it('非 DigestFailureError 的意外错误（如 DB 写失败）向上抛，不静默吞', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    // update().set().where() 抛错模拟 DB 故障。
    const update = vi.fn(() => ({
      set: () => ({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
    }));
    const dbStub = { update } as never;
    await expect(
      digestEvent(
        { eventId: 'evt-5', representativeTitle: '标题', canonicalUrl: null },
        { generateObjectFn, logError: () => {} },
        dbStub,
      ),
    ).rejects.toThrow('DB write failed');
  });
});
