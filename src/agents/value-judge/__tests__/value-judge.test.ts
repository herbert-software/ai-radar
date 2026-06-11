/**
 * Value Judge 单元测试（任务 5.5）——纯 mock LLM，不依赖真实 key。
 *
 * 覆盖：
 * 1. schema 校验通过路径返回正确结构。
 * 2. 字段名映射正确（importance→importance_score 等，不串列）。
 * 3. 校验失败时降级抛错（不返回未校验数据；由调用方保证不写库）。
 *
 * 纯逻辑用例无需 DB。真实落库（按 dedup_key 塌缩 + 写分往返）由 P1 流水线相关组实现，
 * 其 integration 测试将另行落地（P0 的 seed roundtrip 脚手架已随 surrogate event_id 迁移退役）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { valueJudgeOutputSchema } from '../schema.js';
import { mapOutputToEventScores } from '../mapping.js';

// judgeRawItem 经 ../index.js 间接 import env（启动期校验，缺关键变量即 throw）。
// 单元测试不依赖真实 key，注入占位 env（仅需非空字符串/合法 URL）后再动态 import，
// 使本套件无需真实凭据、无需 DB 即可跑。
let judgeRawItem: typeof import('../index.js').judgeRawItem;
let ValueJudgeFailureError: typeof import('../index.js').ValueJudgeFailureError;

beforeAll(async () => {
  // 用 ||= 而非 ??=：空串 env（已定义但为空，如 `export DATABASE_URL=`）也覆盖为占位，
  // 否则 env.ts 的 .min(1) 会让本「纯单元、无需 DB」套件在 import 期 throw（假红）。
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  // LLM_BASE_URL 虽有 .default()，但 .default() 不救空串（`export LLM_BASE_URL=`），
  // .url('') 会拒 → 套件 import 期假红。故同样用 ||= 占位，覆盖空串与 undefined 两态。
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  // P1 起 env.ts 把 TELEGRAM_* 列为必填；本纯单元套件不发推送，注入占位仅过 import 期校验。
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  const mod = await import('../index.js');
  judgeRawItem = mod.judgeRawItem;
  ValueJudgeFailureError = mod.ValueJudgeFailureError;
});

const VALID_OUTPUT = {
  is_ai_related: true,
  type: 'ai_product',
  category: 'AI Coding',
  importance: 82,
  novelty: 75,
  developer_relevance: 90,
  hype_risk: 35,
  should_push: true,
  reason: 'A new open-source coding agent.',
};

describe('valueJudgeOutputSchema', () => {
  it('接受对齐 QA §10.4 的合法输出', () => {
    expect(valueJudgeOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);
  });

  it('拒绝越界评分（>100）', () => {
    const bad = { ...VALID_OUTPUT, importance: 150 };
    expect(valueJudgeOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('拒绝缺字段', () => {
    const missing: Record<string, unknown> = { ...VALID_OUTPUT };
    delete missing.reason;
    expect(valueJudgeOutputSchema.safeParse(missing).success).toBe(false);
  });
});

describe('mapOutputToEventScores 字段名映射', () => {
  it('各评分字段映射到带 _score 后缀的对应列，不串列', () => {
    const mapped = mapOutputToEventScores(VALID_OUTPUT);
    // 数值相等（NUMERIC 落库为字符串，用 Number 比较，禁字面严格相等）。
    expect(Number(mapped.importanceScore)).toBe(VALID_OUTPUT.importance);
    expect(Number(mapped.noveltyScore)).toBe(VALID_OUTPUT.novelty);
    expect(Number(mapped.developerRelevanceScore)).toBe(
      VALID_OUTPUT.developer_relevance,
    );
    expect(Number(mapped.hypeRiskScore)).toBe(VALID_OUTPUT.hype_risk);
    expect(mapped.shouldPush).toBe(VALID_OUTPUT.should_push);
  });

  it('用各不相同的取值证明 importance 未被 novelty 等串入', () => {
    const distinct = {
      ...VALID_OUTPUT,
      importance: 11,
      novelty: 22,
      developer_relevance: 33,
      hype_risk: 44,
    };
    const mapped = mapOutputToEventScores(distinct);
    expect(Number(mapped.importanceScore)).toBe(11);
    expect(Number(mapped.noveltyScore)).toBe(22);
    expect(Number(mapped.developerRelevanceScore)).toBe(33);
    expect(Number(mapped.hypeRiskScore)).toBe(44);
  });
});

describe('judgeRawItem（mock generateObject）', () => {
  it('校验通过路径：返回经 Zod 校验的结构', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const result = await judgeRawItem(
      { title: 'seed title' },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回不符 schema：有限重试后降级抛 ValueJudgeFailureError，不返回未校验数据', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { is_ai_related: 'not-a-bool' } });
    const logError = vi.fn();
    await expect(
      judgeRawItem(
        { title: 'seed title' },
        { generateObjectFn, maxAttempts: 2, logError },
      ),
    ).rejects.toBeInstanceOf(ValueJudgeFailureError);
    // 有限重试用尽：调用次数 = maxAttempts；且每次失败都记了日志（非静默）。
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('generateObject 抛错：记录日志并重试，最终降级', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValue(new Error('LLM down'));
    const logError = vi.fn();
    await expect(
      judgeRawItem(
        { title: 'seed title' },
        { generateObjectFn, maxAttempts: 3, logError },
      ),
    ).rejects.toBeInstanceOf(ValueJudgeFailureError);
    expect(generateObjectFn).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it('首次失败后重试成功：返回校验结果', async () => {
    const generateObjectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ object: VALID_OUTPUT });
    const result = await judgeRawItem(
      { title: 'seed title' },
      { generateObjectFn, maxAttempts: 3, logError: () => {} },
    );
    expect(result).toEqual(VALID_OUTPUT);
    expect(generateObjectFn).toHaveBeenCalledTimes(2);
  });
});
