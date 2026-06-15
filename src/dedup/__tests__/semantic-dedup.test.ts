/**
 * 语义去重纯逻辑/注入桩单测（组 D 任务 4.2/4.3，不触网、不连 DB）。
 *
 * 覆盖：
 * - classifySimilarity 阈值边界（显式钉死，避免浮点 == 歧义）：>high / (llm,high] / <=llm。
 * - judgeSameEvent：注入桩 same/diff、Zod 校验不过、调用失败 → 降级=不合并（degraded=true、不抛断）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let search: typeof import('../semantic-search.js');
let judge: typeof import('../semantic-judge.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  search = await import('../semantic-search.js');
  judge = await import('../semantic-judge.js');
});

describe('classifySimilarity（阈值分流边界显式钉死）', () => {
  const high = 0.88;
  const llm = 0.82;

  it('sim > high → high-auto', () => {
    expect(search.classifySimilarity(0.881, high, llm)).toBe('high-auto');
    expect(search.classifySimilarity(0.95, high, llm)).toBe('high-auto');
  });

  it('sim == high（边界）→ llm-gray（非 high-auto，>high 才合并）', () => {
    // 边界 0.88 落在 (llm, high]，交 LLM，不直接合并（避免浮点 == 歧义：用 > 严格判）。
    expect(search.classifySimilarity(0.88, high, llm)).toBe('llm-gray');
  });

  it('llm < sim < high → llm-gray', () => {
    expect(search.classifySimilarity(0.85, high, llm)).toBe('llm-gray');
    expect(search.classifySimilarity(0.821, high, llm)).toBe('llm-gray');
  });

  it('sim == llm（边界）→ no-merge（<=llm 不合并）', () => {
    expect(search.classifySimilarity(0.82, high, llm)).toBe('no-merge');
  });

  it('sim < llm → no-merge', () => {
    expect(search.classifySimilarity(0.5, high, llm)).toBe('no-merge');
    expect(search.classifySimilarity(0.0, high, llm)).toBe('no-merge');
  });
});

describe('judgeSameEvent（LLM 二次判断 + 降级=不合并）', () => {
  it('桩判 same_event=true → sameEvent=true、degraded=false', async () => {
    const stub = vi.fn().mockResolvedValue({
      object: { same_event: true, same_product: false, reason: 'same release' },
    });
    const r = await judge.judgeSameEvent(
      { titleA: 'GPT-5 out', titleB: 'OpenAI ships GPT-5' },
      { generateObjectFn: stub as never, logError: () => {} },
    );
    expect(r.sameEvent).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.reason).toBe('same release');
  });

  it('桩判 same_event=false → sameEvent=false、degraded=false（真实判定的不合并，非降级）', async () => {
    const stub = vi.fn().mockResolvedValue({
      object: { same_event: false, same_product: false, reason: 'different events' },
    });
    const r = await judge.judgeSameEvent(
      { titleA: 'A', titleB: 'B' },
      { generateObjectFn: stub as never, logError: () => {} },
    );
    expect(r.sameEvent).toBe(false);
    expect(r.degraded).toBe(false);
  });

  it('Zod 校验不过（缺字段）→ 重试耗尽降级=不合并（degraded=true、不抛断）', async () => {
    const stub = vi.fn().mockResolvedValue({ object: { same_event: true } }); // 缺 same_product/reason
    const logError = vi.fn();
    const r = await judge.judgeSameEvent(
      { titleA: 'A', titleB: 'B' },
      { generateObjectFn: stub as never, maxAttempts: 2, logError },
    );
    expect(r.sameEvent).toBe(false);
    expect(r.degraded).toBe(true);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalled(); // 降级被记录（非静默）
  });

  it('调用恒抛 → 降级=不合并（degraded=true、绝不抛断，欠合并安全）', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('LLM down'));
    const r = await judge.judgeSameEvent(
      { titleA: 'A', titleB: 'B' },
      { generateObjectFn: stub as never, maxAttempts: 3, logError: () => {} },
    );
    expect(r.sameEvent).toBe(false);
    expect(r.sameProduct).toBe(false);
    expect(r.degraded).toBe(true);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it('same_product 仅采集留存（被原样透出，但本期不消费——不触发任何产品合并）', async () => {
    const stub = vi.fn().mockResolvedValue({
      object: { same_event: true, same_product: true, reason: 'same product launch' },
    });
    const r = await judge.judgeSameEvent(
      { titleA: 'A', titleB: 'B' },
      { generateObjectFn: stub as never, logError: () => {} },
    );
    // same_product 被透出（供后续产品语义合并预留），但 judgeSameEvent 不据此做任何产品写入。
    expect(r.sameProduct).toBe(true);
  });
});
