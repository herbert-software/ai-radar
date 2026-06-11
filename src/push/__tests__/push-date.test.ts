/**
 * push_date 时间源单测（任务 9.1）—— 纯逻辑，无 DB / 无网络 / 无 LLM。
 *
 * 守住不变量：push_date 按 Asia/Shanghai 算「今天」，跨 UTC 零点不算成两天。
 * 关键用例构造「UTC 是某日、但上海已是次日」的时刻，断言 getPushDate 返回上海口径日期。
 */
import { beforeAll, describe, expect, it } from 'vitest';

// push-date.js 间接 import config/env（启动期校验全部必填变量）。注入占位让 import 通过。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';

let getPushDate: typeof import('../push-date.js').getPushDate;
let dateInTimeZone: typeof import('../push-date.js').dateInTimeZone;
let startOfDayInTimeZone: typeof import('../push-date.js').startOfDayInTimeZone;

beforeAll(async () => {
  ({ getPushDate, dateInTimeZone, startOfDayInTimeZone } = await import(
    '../push-date.js'
  ));
});

describe('getPushDate（Asia/Shanghai 口径）', () => {
  it('UTC 仍是 6/10 晚但上海已进入 6/11 时，push_date 取上海的 6/11', () => {
    // 2026-06-10T17:00:00Z = 上海 2026-06-11T01:00（UTC+8）。
    const at = new Date('2026-06-10T17:00:00Z');
    expect(getPushDate(at)).toBe('2026-06-11');
  });

  it('UTC 已跨到 6/11 凌晨但上海仍是 6/11 白天，两侧同日不歧义', () => {
    // 2026-06-11T02:00:00Z = 上海 2026-06-11T10:00。
    const at = new Date('2026-06-11T02:00:00Z');
    expect(getPushDate(at)).toBe('2026-06-11');
  });

  it('上海跨零点：UTC 15:59 与 16:01 落在上海相邻两天', () => {
    // 上海零点 = 前一日 16:00 UTC。
    const beforeMidnight = new Date('2026-06-10T15:59:00Z'); // 上海 23:59 6/10
    const afterMidnight = new Date('2026-06-10T16:01:00Z'); // 上海 00:01 6/11
    expect(getPushDate(beforeMidnight)).toBe('2026-06-10');
    expect(getPushDate(afterMidnight)).toBe('2026-06-11');
  });

  it('同一 UTC 日内的不同时刻只要落在同一上海日，push_date 一致（不算成两天）', () => {
    const morning = new Date('2026-06-11T03:00:00Z'); // 上海 11:00
    const evening = new Date('2026-06-11T09:00:00Z'); // 上海 17:00
    expect(getPushDate(morning)).toBe(getPushDate(evening));
    expect(getPushDate(morning)).toBe('2026-06-11');
  });

  it('输出形如 YYYY-MM-DD（匹配 push_records.push_date DATE 列）', () => {
    expect(getPushDate(new Date('2026-01-05T12:00:00Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('dateInTimeZone 可显式指定时区：同一时刻 UTC 与上海可能落不同日', () => {
    const at = new Date('2026-06-10T17:00:00Z');
    expect(dateInTimeZone(at, 'UTC')).toBe('2026-06-10');
    expect(dateInTimeZone(at, 'Asia/Shanghai')).toBe('2026-06-11');
  });
});

describe('startOfDayInTimeZone（上海自然日 00:00 → UTC，候选窗口下界）', () => {
  it('daysBack=0：上海今天 00:00 对应前一日 16:00 UTC', () => {
    // 2026-06-10T17:00:00Z = 上海 6/11 01:00；上海 6/11 00:00 = 6/10 16:00 UTC。
    const at = new Date('2026-06-10T17:00:00Z');
    expect(startOfDayInTimeZone(at, 0, 'Asia/Shanghai').toISOString()).toBe(
      '2026-06-10T16:00:00.000Z',
    );
  });

  it('daysBack=2：上海今天往前第 2 个自然日的 00:00（含今天即 3 天窗口下界）', () => {
    // 上海今天 = 6/11；往前 2 天 = 上海 6/09 00:00 = 6/08 16:00 UTC。
    const at = new Date('2026-06-10T17:00:00Z');
    expect(startOfDayInTimeZone(at, 2, 'Asia/Shanghai').toISOString()).toBe(
      '2026-06-08T16:00:00.000Z',
    );
  });

  it('与 getPushDate 同源：下界正是 push_date 当日往前推算的上海日 00:00', () => {
    // 跨 UTC 零点后仍以上海日为准：6/10 16:01Z → 上海 6/11；daysBack=0 下界 = 6/10 16:00Z。
    const at = new Date('2026-06-10T16:01:00Z');
    expect(getPushDate(at)).toBe('2026-06-11');
    expect(startOfDayInTimeZone(at, 0, 'Asia/Shanghai').toISOString()).toBe(
      '2026-06-10T16:00:00.000Z',
    );
  });
});
