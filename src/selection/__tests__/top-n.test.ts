/**
 * Top N 选择单测（任务 8.3）—— 纯逻辑，无 DB / 无网络 / 无 LLM。
 *
 * 覆盖确定性排序与组合分（候选窗口的 should_push / 近 N 天 / 从未 success 等 SQL 条件
 * 由 top-n 集成测断言，本单测专注程序侧的可复现排序与权重计算）：
 * - 候选多于 N 时按 rank_score 降序取前 N，对同一批输入多次运行结果一致。
 * - 确定性 tiebreaker：published_at DESC NULLS LAST, event_id ASC。
 * - 组合分按权重 0.45/0.25/0.20/−0.10 计算（hype 为减项）。
 */
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';

let computeRankScore: typeof import('../top-n.js').computeRankScore;
let rankAndSelect: typeof import('../top-n.js').rankAndSelect;
let compareForTopN: typeof import('../top-n.js').compareForTopN;
type SelectedEvent = import('../top-n.js').SelectedEvent;

beforeAll(async () => {
  ({ computeRankScore, rankAndSelect, compareForTopN } = await import(
    '../top-n.js'
  ));
});

const WEIGHTS = {
  importance: 0.45,
  developerRelevance: 0.25,
  novelty: 0.2,
  hypeRisk: 0.1,
};

function ev(
  eventId: string,
  rankScore: number,
  publishedAt: Date | null = null,
): SelectedEvent {
  return {
    eventId,
    representativeTitle: `t-${eventId}`,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt,
    rankScore,
  };
}

describe('computeRankScore', () => {
  it('按 0.45*imp + 0.25*dev + 0.20*nov − 0.10*hype 计算', () => {
    const score = computeRankScore(
      { importance: 80, developerRelevance: 90, novelty: 70, hypeRisk: 40 },
      WEIGHTS,
    );
    // 0.45*80 + 0.25*90 + 0.20*70 − 0.10*40 = 36 + 22.5 + 14 − 4 = 68.5
    expect(score).toBeCloseTo(68.5, 6);
  });

  it('hype_risk 是减项：hype 越高分越低', () => {
    const base = { importance: 80, developerRelevance: 80, novelty: 80, hypeRisk: 0 };
    const hyped = { ...base, hypeRisk: 100 };
    expect(computeRankScore(hyped, WEIGHTS)).toBeLessThan(
      computeRankScore(base, WEIGHTS),
    );
  });
});

describe('rankAndSelect（确定性 Top N）', () => {
  it('候选多于 N 时按 rank_score 降序取前 N', () => {
    const candidates = [
      ev('a', 10),
      ev('b', 50),
      ev('c', 30),
      ev('d', 90),
      ev('e', 20),
    ];
    const top = rankAndSelect(candidates, 3);
    expect(top.map((e) => e.eventId)).toEqual(['d', 'b', 'c']);
  });

  it('对同一批输入多次运行结果完全一致（可复现）', () => {
    const candidates = [
      ev('e1', 70, new Date('2026-06-01T00:00:00Z')),
      ev('e2', 70, new Date('2026-06-02T00:00:00Z')),
      ev('e3', 85, null),
      ev('e4', 70, null),
      ev('e5', 85, new Date('2026-06-05T00:00:00Z')),
    ];
    const first = rankAndSelect(candidates, 4).map((e) => e.eventId);
    const second = rankAndSelect([...candidates].reverse(), 4).map((e) => e.eventId);
    expect(first).toEqual(second);
  });

  it('不修改入参数组（纯函数）', () => {
    const candidates = [ev('a', 10), ev('b', 90)];
    const snapshot = candidates.map((e) => e.eventId);
    rankAndSelect(candidates, 2);
    expect(candidates.map((e) => e.eventId)).toEqual(snapshot);
  });
});

describe('compareForTopN（tiebreaker：published_at DESC NULLS LAST, event_id ASC）', () => {
  it('同 rank_score 时 published_at 晚者排前', () => {
    const early = ev('x', 50, new Date('2026-06-01T00:00:00Z'));
    const late = ev('y', 50, new Date('2026-06-09T00:00:00Z'));
    expect([early, late].sort(compareForTopN).map((e) => e.eventId)).toEqual([
      'y',
      'x',
    ]);
  });

  it('同 rank_score 时 published_at 非空优先于 NULL（NULLS LAST）', () => {
    const withDate = ev('x', 50, new Date('2026-06-01T00:00:00Z'));
    const nullDate = ev('y', 50, null);
    expect([nullDate, withDate].sort(compareForTopN).map((e) => e.eventId)).toEqual([
      'x',
      'y',
    ]);
  });

  it('rank_score 与 published_at 均相同时按 event_id ASC（字典序）', () => {
    const pub = new Date('2026-06-01T00:00:00Z');
    const a = ev('aaa', 50, pub);
    const b = ev('bbb', 50, pub);
    expect([b, a].sort(compareForTopN).map((e) => e.eventId)).toEqual([
      'aaa',
      'bbb',
    ]);
  });

  it('两者 published_at 均为 NULL 时仍按 event_id ASC 确定有序', () => {
    const a = ev('m1', 50, null);
    const b = ev('m2', 50, null);
    expect([b, a].sort(compareForTopN).map((e) => e.eventId)).toEqual([
      'm1',
      'm2',
    ]);
  });
});
