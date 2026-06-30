/**
 * 组 C 纯函数测（add-model-radar-compare-web-page / task 7.x）——直测 render.ts，不 boot server。
 *
 * 覆盖：
 * - 7.4 age **live**：同 `lastCheckedDate`、不同 `render_now` → 不同文案（age 随 render 时钟变、数据 date 不变）。
 * - 7.6 估算旋钮：区间随 `tokensPerRound` 重算；`limit.value=null`/无 token 额度/非正旋钮 → null（降级不 NPE）。
 * - 支撑 7.1/7.2 的判定纯函数：safeHref scheme 闸、cheapestInfo（≥2 才出 + 跨引 unknownCount）、
 *   freshnessSortKey（null 源最陈旧）、sortPlansByFreshness、facetOptions（model value 恒含冒号）。
 */
import { describe, expect, it } from 'vitest';
import {
  ageBadge,
  cheapestInfo,
  facetOptions,
  freshnessSortKey,
  oldestFactBadge,
  resolveTokensPerRound,
  safeHref,
  sortPlansByFreshness,
  sourceHost,
} from '../render.js';
import { estimateRounds } from '../../snapshot/limits.js';
import { client, group, known, limit, model, source, unknown } from './fixtures.js';

describe('7.4 per-fact age 徽标 live（render_now − lastCheckedDate，相对文案只在 render 层算）', () => {
  it('同一 date、不同 now → 不同文案（证 age 由 render 时钟派生、live）', () => {
    const date = '2026-06-20';
    const sameDay = ageBadge(date, new Date('2026-06-20T08:00:00Z'));
    expect(sameDay.kind).toBe('today');
    expect(sameDay.label).toBe('今日核对');
    expect(sameDay.emoji).toBe('🟢');

    const threeDaysLater = ageBadge(date, new Date('2026-06-23T23:30:00Z'));
    expect(threeDaysLater.kind).toBe('days');
    expect(threeDaysLater.days).toBe(3);
    expect(threeDaysLater.label).toBe('3 天前核对');
    expect(threeDaysLater.emoji).toBe('🟡');

    // 同数据 date 产出不同 label → 文案绝非数据派生常量，而是 render_now 相对量（live，不会被 304 冻住）。
    expect(sameDay.label).not.toBe(threeDaysLater.label);
  });

  it('跨 UTC 午夜按整日截断算 N 天', () => {
    expect(ageBadge('2026-06-20', new Date('2026-06-21T00:00:01Z')).days).toBe(1);
  });

  it('lastCheckedDate=null（从未抓的关联源）→ 待核态、无 emoji、不显 🟢🟡', () => {
    const b = ageBadge(null, new Date('2026-06-23T00:00:00Z'));
    expect(b.kind).toBe('unchecked');
    expect(b.emoji).toBe('');
    expect(b.label).toContain('待核');
  });

  it('未来日期（时钟偏移）并入「今日」不出现负数天', () => {
    const b = ageBadge('2026-06-25', new Date('2026-06-20T00:00:00Z'));
    expect(b.kind).toBe('today');
    expect(b.days).toBe(0);
  });
});

describe('7.6 估算中等任务轮次旋钮（render 层、不引快照外事实、不进哈希）', () => {
  const tokenLimit = limit('monthly_tokens', '300000', 'monthly');

  it('区间随 tokensPerRound 重算（同限额、不同假设 → 不同区间）', () => {
    const at15k = estimateRounds([tokenLimit], 15_000);
    const at5k = estimateRounds([tokenLimit], 5_000);
    expect(at15k).toEqual({
      basis: { limitType: 'monthly_tokens', value: '300000', window: 'monthly' },
      tokensPerRound: 15_000,
      low: 13,
      high: 40,
    });
    expect(at5k).toEqual({
      basis: { limitType: 'monthly_tokens', value: '300000', window: 'monthly' },
      tokensPerRound: 5_000,
      low: 40,
      high: 120,
    });
    expect(at15k!.high).not.toBe(at5k!.high); // 区间确随假设变
  });

  it('limit.value=null（不限/占位）→ 返回 null（降级、不 NPE、不 NaN）', () => {
    const est = estimateRounds([limit('monthly_tokens', null, 'monthly')], 15_000);
    expect(est).toBeNull();
  });

  it('无 token 额度事实 → null', () => {
    expect(estimateRounds([limit('credit', '100', 'monthly')], 15_000)).toBeNull();
    expect(estimateRounds([], 15_000)).toBeNull();
  });

  it('旋钮非正（0 / 负 / 畸形）→ null（不除零、不出 Infinity）', () => {
    expect(estimateRounds([tokenLimit], 0)).toBeNull();
    expect(estimateRounds([tokenLimit], -5)).toBeNull();
    expect(estimateRounds([tokenLimit], Number.NaN)).toBeNull();
  });

  it('resolveTokensPerRound：仅认预设三档白名单；缺省/非预设/畸形 → 默认 15k', () => {
    expect(resolveTokensPerRound(undefined)).toBe(15_000);
    expect(resolveTokensPerRound('5000')).toBe(5_000);
    expect(resolveTokensPerRound('40000')).toBe(40_000);
    expect(resolveTokensPerRound('0')).toBe(15_000);
    expect(resolveTokensPerRound('-5')).toBe(15_000);
    expect(resolveTokensPerRound('abc')).toBe(15_000);
    // 非预设有限正数（crafted）→ 默认，不放行 → 不会算出 Infinity/巨数估算、下拉回显与生效一致
    expect(resolveTokensPerRound('9999')).toBe(15_000);
    expect(resolveTokensPerRound('5e-324')).toBe(15_000);
    expect(resolveTokensPerRound('1e400')).toBe(15_000); // Infinity 不在白名单
  });
});

describe('7.3 支撑：safeHref scheme 闸（仅放行 http/https，否则 null → 组件降级纯文本）', () => {
  it('http/https 原样返回', () => {
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('https://docs.foo.com/pricing')).toBe('https://docs.foo.com/pricing');
  });

  it('javascript:/data:/ftp: / 相对 / 畸形 → null', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('ftp://example.com/x')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('含 userinfo 的 http(s)（good.com@evil.com 钓鱼诱导）→ null（降级纯文本）', () => {
    expect(safeHref('https://good.com@evil.com/path')).toBeNull();
    expect(safeHref('http://user:pass@evil.com/')).toBeNull();
  });

  it('sourceHost 取 host 作链接名后缀；畸形 → 空串', () => {
    expect(sourceHost('https://docs.foo.com/x')).toBe('docs.foo.com');
    expect(sourceHost('not a url')).toBe('');
  });
});

describe('7.2 支撑：cheapestInfo（已核 plans.length≥2 才出、跨引 unknownCount）', () => {
  it('≥2 已核 + cheapestPlanId → 输出，unknownCount 取跨引值（非已核组上的 0）', () => {
    const info = cheapestInfo(group(), 2); // 已核组自身 unknownCount=0，跨引 category null 组的 2
    expect(info.showCheapest).toBe(true);
    expect(info.cheapestPlanId).toBe('A');
    expect(info.unknownCount).toBe(2);
  });

  it('单 plan 已核组（comparable=true 仍不足）→ 不输出最划算', () => {
    const single = group({ plans: [known('A', '30', 'CNY')], cheapestPlanId: 'A' });
    const info = cheapestInfo(single, 0);
    expect(info.showCheapest).toBe(false);
    expect(info.cheapestPlanId).toBeNull();
  });

  it('cheapestPlanId 为 null → 不输出', () => {
    const none = group({ cheapestPlanId: null });
    expect(cheapestInfo(none, 0).showCheapest).toBe(false);
  });
});

describe('7.1 支撑：freshnessSortKey / sortPlansByFreshness（null 源最陈旧）', () => {
  it('freshnessSortKey 取 plan 全部 fact 的最旧 date', () => {
    const p = known('A', '30', 'CNY', {
      provenance: { sourceUrl: 'https://x', sourceConfidence: 'official_pricing', lastCheckedDate: '2026-06-20' },
      models: [model('glm', '5.2', { lastCheckedDate: '2026-06-10' })],
      limits: [limit('monthly_tokens', '100', 'monthly', { lastCheckedDate: '2026-06-25' })],
    });
    expect(freshnessSortKey(p)).toBe('2026-06-10');
  });

  it('任一关联源 date=null（从未抓）→ 视为最陈旧（空串、排所有日期前）', () => {
    const p = known('A', '30', 'CNY', { sources: [source('https://s', 'browser', null)] });
    expect(freshnessSortKey(p)).toBe('');
  });

  it('sortPlansByFreshness：stale=最陈旧优先、fresh=最新优先、null 源恒最前(stale)', () => {
    const fresh = known('Fresh', '30', 'CNY', {
      provenance: { sourceUrl: 'https://x', sourceConfidence: 'official_pricing', lastCheckedDate: '2026-06-25' },
    });
    const old = known('Old', '30', 'CNY', {
      provenance: { sourceUrl: 'https://x', sourceConfidence: 'official_pricing', lastCheckedDate: '2026-06-01' },
    });
    const neverFetched = known('Never', '30', 'CNY', { sources: [source('https://s', 'browser', null)] });

    const stale = sortPlansByFreshness([fresh, old, neverFetched], 'stale');
    expect(stale.map((p) => p.id)).toEqual(['Never', 'Old', 'Fresh']);

    const freshFirst = sortPlansByFreshness([fresh, old, neverFetched], 'fresh');
    expect(freshFirst.map((p) => p.id)).toEqual(['Fresh', 'Old', 'Never']);
  });

  it('oldestFactBadge：含 null 源 → 待核徽标；否则按最旧 date 算 age', () => {
    const neverFetched = known('N', '30', 'CNY', { sources: [source('https://s', 'browser', null)] });
    expect(oldestFactBadge(neverFetched, new Date('2026-06-29T00:00:00Z')).kind).toBe('unchecked');
  });
});

describe('7.1 支撑：facetOptions（model value 恒含冒号、tools/protocols 分流）', () => {
  it('派生 model/tool/protocol 选项；空版本 value 仍含冒号（对齐 query.ts 400 闸）', () => {
    const plans = [
      known('A', '30', 'CNY', {
        models: [model('glm', '5.2'), model('foo', '')],
        clients: [client('tool', 'claude-code'), client('protocol', 'mcp')],
      }),
      unknown('B', { models: [model('glm', '5.2')] }), // 去重
    ];
    const opts = facetOptions(plans);

    expect(opts.models.map((m) => m.value)).toEqual(['foo:', 'glm:5.2']);
    expect(opts.models.every((m) => m.value.includes(':'))).toBe(true);
    expect(opts.models.find((m) => m.value === 'foo:')!.label).toBe('foo'); // 空版本 label 退化为 family
    expect(opts.tools).toEqual(['claude-code']);
    expect(opts.protocols).toEqual(['mcp']);
  });
});
