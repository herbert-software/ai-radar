/**
 * env 校验单元测试（任务 1.3）。
 *
 * 守住不变量：关键变量缺失时 `parseEnv` 启动即抛错（快速失败），
 * 禁止静默用空值/默认值继续运行。同时验证 P1 新增的数值/比率配置：
 * - 默认值在未提供时生效；
 * - 非法值（NaN / 越界）被拒绝；
 * - RSS_FEEDS 逗号分隔解析为去空白的非空数组。
 *
 * 纯函数测试，不触发 import 期的 `env` 单例校验（直接调用导出的 parseEnv）。
 */
import { beforeAll, describe, expect, it } from 'vitest';

// env.ts 在 import 期会以 process.env 评估 `env` 单例（缺关键变量即 throw）。
// 本套件只测纯函数 parseEnv，注入占位让 import 期单例校验通过后再动态取 parseEnv，
// 使套件在不完整 shell env 下也能干净运行（占位绝不影响 parseEnv 的入参——它收显式 source）。
let parseEnv: typeof import('../env.js').parseEnv;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  ({ parseEnv } = await import('../env.js'));
});

/** 一份能通过校验的最小合法 env。各用例在其上做删除/改写。 */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://ai_radar:ai_radar@localhost:5432/ai_radar',
    REDIS_URL: 'redis://localhost:6379',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'openai/gpt-4o-mini',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '123456',
  } as NodeJS.ProcessEnv;
}

describe('parseEnv —— 关键变量缺失快速失败', () => {
  it('完整合法 env 通过校验并填充默认值', () => {
    const env = parseEnv(validEnv());
    expect(env.PUSH_TIMEZONE).toBe('Asia/Shanghai');
    expect(env.TOP_N).toBe(8);
    expect(env.RANK_WEIGHT_IMPORTANCE).toBe(0.45);
    expect(env.RANK_WEIGHT_DEVELOPER_RELEVANCE).toBe(0.25);
    expect(env.RANK_WEIGHT_NOVELTY).toBe(0.2);
    expect(env.RANK_WEIGHT_HYPE_RISK).toBe(0.1);
    expect(env.IMPORTANCE_FLOOR).toBe(60);
    expect(env.DEGRADE_ABORT_RATIO).toBe(0.5);
    expect(env.FIRST_SEEN_WINDOW_DAYS).toBe(3);
    expect(env.RSS_FEEDS).toEqual([]);
    expect(env.GITHUB_TOKEN).toBe('');
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
  ])('缺失 %s 时抛错', (key) => {
    const source = validEnv();
    delete source[key];
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('LLM_BASE_URL 缺失时用默认 OpenRouter 端点', () => {
    const env = parseEnv(validEnv());
    expect(env.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});

describe('parseEnv —— P1 数值/比率配置校验', () => {
  it('非数字 TOP_N 被拒绝', () => {
    const source = { ...validEnv(), TOP_N: 'not-a-number' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('DEGRADE_ABORT_RATIO 越界（>1）被拒绝', () => {
    const source = { ...validEnv(), DEGRADE_ABORT_RATIO: '1.5' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('IMPORTANCE_FLOOR 越界（>100）被拒绝', () => {
    const source = { ...validEnv(), IMPORTANCE_FLOOR: '200' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('TOP_N 非正数（0）被拒绝', () => {
    const source = { ...validEnv(), TOP_N: '0' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('自定义数值生效', () => {
    const source = {
      ...validEnv(),
      TOP_N: '5',
      IMPORTANCE_FLOOR: '70',
      DEGRADE_ABORT_RATIO: '0.3',
      FIRST_SEEN_WINDOW_DAYS: '7',
      PUSH_TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.TOP_N).toBe(5);
    expect(env.IMPORTANCE_FLOOR).toBe(70);
    expect(env.DEGRADE_ABORT_RATIO).toBe(0.3);
    expect(env.FIRST_SEEN_WINDOW_DAYS).toBe(7);
    expect(env.PUSH_TIMEZONE).toBe('UTC');
  });
});

describe('parseEnv —— RSS_FEEDS 列表解析', () => {
  it('逗号分隔解析为去空白的非空数组', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: ' https://a.example/feed.xml , https://b.example/rss ,, ',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.RSS_FEEDS).toEqual([
      'https://a.example/feed.xml',
      'https://b.example/rss',
    ]);
  });
});
