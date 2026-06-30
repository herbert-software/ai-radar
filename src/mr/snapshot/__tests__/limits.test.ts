/**
 * snapshot 层额度原语纯单测（add-model-radar-recommender task 4.1，**无 DB**，design D2）。
 *
 * 覆盖：
 * - `fitsWindow` 6-arm 按 `limitType` 分派：`none`→fits / `monthly_tokens` 非 NULL→fits·exceeds·带内 unknown /
 *   `rolling_5h_requests`·`weekly_messages`·`credit`·`fast_pass`·真限额 `value:NULL`→unknown；
 * - 多限额取最紧（任一 exceeds→exceeds；否则任一 unknown→unknown；全 fits→fits）；
 * - **空 `limits[]`→unknown（聚合恒等元 = unknown，非 vacuous fits）**；
 * - 下沉后 `estimateRounds` 与原 render 行为等价（同输入同输出，对齐 render.test.ts 7.6）。
 */
import { describe, expect, it } from 'vitest';
import { estimateRounds, fitsWindow } from '../limits.js';
import type { SnapshotLimit } from '../dto.js';
import { mrLimitTypeSchema } from '../../../db/mr-schema.zod.js';

/** 极简 SnapshotLimit 工厂（provenance 仅满足类型，撞窗判定不读它）。 */
function mkLimit(
  limitType: SnapshotLimit['limitType'],
  value: string | null,
  window = 'monthly',
): SnapshotLimit {
  return {
    limitType,
    value,
    window,
    provenance: { sourceUrl: 'https://x', sourceConfidence: 'official_pricing', lastCheckedDate: '2026-06-20' },
  };
}

// monthly_tokens '300000' @ 15k/轮 → estimateRounds low=13 / high=40（与 render.test 同）。
const TOKENS = '300000';
const PER_ROUND = 15_000;

describe('4.1 fitsWindow 6-arm 按 limitType 分派', () => {
  it('none（不限）→ fits（先于 value===null 兜底命中）', () => {
    // value 为 NULL 但 limitType=none → fits（唯一据 NULL 报「不撞窗」的合法情形）。
    expect(fitsWindow([mkLimit('none', null, 'none')], 999_999, PER_ROUND)).toBe('fits');
  });

  it('monthly_tokens 非 NULL：demandedRounds≤low→fits、≥high→exceeds、带内→unknown', () => {
    const limits = [mkLimit('monthly_tokens', TOKENS)];
    expect(fitsWindow(limits, 10, PER_ROUND)).toBe('fits'); // 10 ≤ low(13)
    expect(fitsWindow(limits, 50, PER_ROUND)).toBe('exceeds'); // 50 ≥ high(40)
    expect(fitsWindow(limits, 25, PER_ROUND)).toBe('unknown'); // 13 < 25 < 40 带内不假装
    expect(fitsWindow(limits, 13, PER_ROUND)).toBe('fits'); // 含界 ≤low
    expect(fitsWindow(limits, 40, PER_ROUND)).toBe('exceeds'); // 含界 ≥high
  });

  it('真限额 value:NULL（占位，非 none）→ unknown（绝不据 NULL 报「不撞窗」）', () => {
    expect(fitsWindow([mkLimit('monthly_tokens', null)], 10, PER_ROUND)).toBe('unknown');
  });

  it('rolling_5h_requests / weekly_messages（无诚实窗换算）→ unknown', () => {
    expect(fitsWindow([mkLimit('rolling_5h_requests', '50', 'rolling_5h')], 10, PER_ROUND)).toBe('unknown');
    expect(fitsWindow([mkLimit('weekly_messages', '500', 'weekly')], 10, PER_ROUND)).toBe('unknown');
  });

  it('credit / fast_pass（口径异构）→ unknown', () => {
    expect(fitsWindow([mkLimit('credit', '100', 'monthly')], 10, PER_ROUND)).toBe('unknown');
    expect(fitsWindow([mkLimit('fast_pass', '20', 'monthly')], 10, PER_ROUND)).toBe('unknown');
  });

  it('全 6 个 limitType 枚举均有分派分支（枚举漂移护栏）', () => {
    // 任一 limitType 入 fitsWindow 都返合法三态之一，不抛、不漏 arm。
    for (const lt of mrLimitTypeSchema.options) {
      const v = fitsWindow([mkLimit(lt, lt === 'none' ? null : '100', 'w')], 10, PER_ROUND);
      expect(['fits', 'exceeds', 'unknown']).toContain(v);
    }
  });
});

describe('4.1 多限额取最紧 + 空限额诚实', () => {
  it('任一 exceeds → exceeds（即便另一条 fits/none）', () => {
    const limits = [mkLimit('monthly_tokens', TOKENS), mkLimit('none', null, 'none')];
    expect(fitsWindow(limits, 50, PER_ROUND)).toBe('exceeds'); // monthly exceeds 压过 none 的 fits
  });

  it('无 exceeds 但有 unknown → unknown（fits + unknown 取紧为 unknown）', () => {
    const limits = [mkLimit('monthly_tokens', TOKENS), mkLimit('credit', '100')];
    expect(fitsWindow(limits, 10, PER_ROUND)).toBe('unknown'); // monthly fits + credit unknown → unknown
  });

  it('全 fits → fits', () => {
    const limits = [mkLimit('none', null, 'none'), mkLimit('monthly_tokens', TOKENS)];
    expect(fitsWindow(limits, 10, PER_ROUND)).toBe('fits');
  });

  it('空 limits[] → unknown（聚合恒等元 = unknown，绝非 vacuous fits）', () => {
    expect(fitsWindow([], 10, PER_ROUND)).toBe('unknown');
  });
});

describe('4.1 下沉后 estimateRounds 与原 render 行为等价（同输入同输出）', () => {
  it('300000 @15k → {low:13, high:40}；@5k → {low:40, high:120}', () => {
    const tokenLimit = mkLimit('monthly_tokens', TOKENS);
    expect(estimateRounds([tokenLimit], 15_000)).toEqual({
      basis: { limitType: 'monthly_tokens', value: '300000', window: 'monthly' },
      tokensPerRound: 15_000,
      low: 13,
      high: 40,
    });
    expect(estimateRounds([tokenLimit], 5_000)).toEqual({
      basis: { limitType: 'monthly_tokens', value: '300000', window: 'monthly' },
      tokensPerRound: 5_000,
      low: 40,
      high: 120,
    });
  });

  it('value=null / 无 token 额度 / 旋钮非正 → null（降级、不 NaN、不抛）', () => {
    expect(estimateRounds([mkLimit('monthly_tokens', null)], 15_000)).toBeNull();
    expect(estimateRounds([mkLimit('credit', '100')], 15_000)).toBeNull();
    expect(estimateRounds([], 15_000)).toBeNull();
    expect(estimateRounds([mkLimit('monthly_tokens', TOKENS)], 0)).toBeNull();
    expect(estimateRounds([mkLimit('monthly_tokens', TOKENS)], Number.NaN)).toBeNull();
  });
});
