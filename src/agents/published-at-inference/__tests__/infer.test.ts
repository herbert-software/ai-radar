/**
 * inferPublishedAt 单元测试（published-at-inference 1.2 / 1.3 / 1.7）——纯 mock LLM，无 DB / 无真实 key。
 *
 * 覆盖：
 * - 推断成功（范围内 ISO）→ 返回归一 ISO 串。
 * - 无法判定（LLM 返回 publishedAt:null）→ 返回 null，不臆造。
 * - 未来 / 荒谬过早日期 → 经 schema transform 归一为 null（refine 兜底，不回填越界值）。
 * - LLM 调用失败（抛错）→ 有限重试后**降级返回 null 且不抛**（与 value-judge 抛降级信号不同）。
 * - schema 校验失败（缺 publishedAt 字段非 null/string）→ 重试后降级返回 null + 记日志（非静默）。
 *
 * inferPublishedAt 经 ../index.js 间接 import env（启动期校验）。注入占位 env 后再动态 import，
 * 使本套件无需真实凭据、无需 DB 即可跑（同 value-judge.test.ts 范式）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let inferPublishedAt: typeof import('../index.js').inferPublishedAt;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  const mod = await import('../index.js');
  inferPublishedAt = mod.inferPublishedAt;
});

const NOW = new Date('2026-06-13T12:00:00Z');
const INPUT = {
  title: 'Introducing ChatGPT',
  canonicalUrl: 'https://openai.com/blog/chatgpt',
  content: null,
  source: 'openai_blog',
};

describe('inferPublishedAt（mock generateObject）', () => {
  it('推断成功（范围内 ISO）→ 返回归一 ISO 串', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({
      object: { publishedAt: '2022-11-30T00:00:00Z', confidence: 0.9 },
    });
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      logError: () => {},
      now: NOW,
    });
    expect(result).toBe('2022-11-30T00:00:00.000Z');
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('无法判定（LLM 返回 publishedAt:null）→ 返回 null，不臆造', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: null } });
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      logError: () => {},
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('未来日期 → 经 schema transform 归一为 null（不回填越界值）', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '2030-01-01T00:00:00Z' } });
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      logError: () => {},
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('荒谬过早日期 → 归一为 null', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: '1888-01-01T00:00:00Z' } });
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      logError: () => {},
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('LLM 调用失败（抛错）→ 有限重试后降级返回 null 且不抛、记日志', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    const logError = vi.fn();
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      maxAttempts: 3,
      logError,
      now: NOW,
    });
    // 关键：降级为 null，**不抛**（发布时间判不出是预期安全失败方向）。
    expect(result).toBeNull();
    expect(generateObjectFn).toHaveBeenCalledTimes(3);
    // 每次失败 + 最终降级各记一次日志（非静默）。
    expect(logError).toHaveBeenCalled();
  });

  it('schema 校验失败（非 string/null 的 publishedAt）→ 重试后降级返回 null + 记日志', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { publishedAt: 12345 } });
    const logError = vi.fn();
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      maxAttempts: 2,
      logError,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalled();
  });

  it('首次失败后重试成功：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ object: { publishedAt: '2021-01-01T00:00:00Z' } });
    const result = await inferPublishedAt(INPUT, {
      generateObjectFn,
      maxAttempts: 3,
      logError: () => {},
      now: NOW,
    });
    expect(result).toBe('2021-01-01T00:00:00.000Z');
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });
});
