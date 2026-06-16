/**
 * 跨段去重抑制纯函数单测（add-cross-segment-dedup-and-hn-purify 组 C，tasks 2.2）。
 *
 * 纯逻辑，无 DB / 无网络 / 无 LLM：只测 `suppressEventsInProducts` 的确定性键比对与
 * `PLATFORM_HOSTS` denylist 语义（编排层的键提取 / 域集构建在 run-daily 集成测覆盖）。
 *
 * 覆盖（spec daily-intel-pipeline 全部场景的纯函数侧）：
 * ① canonical_domain 命中剔除（grassdx 类）；
 * ② github_repo 命中剔除（github 直链类）；
 * ③ github 来源要闻不被 mass 误抑制（关键回归，防 round-1 blocker）；
 * ④ 平台 host 不致误抑制（产品域集构建排除 PLATFORM_HOSTS 后，含该域的产品不误抑制要闻）；
 * ⑤ product_hunt_slug 命中剔除；
 * ⑥ 三键全不命中 → 保留；
 * ⑦ 事件 url 为 null / 无键 → 保留；
 * ⑧ 产品集全空 → 全保留。
 */
import { describe, expect, it } from 'vitest';
import {
  suppressEventsInProducts,
  PLATFORM_HOSTS,
  type EventWithKeys,
  type ProductKeySets,
} from '../cross-segment-dedup.js';
import type { SelectedEvent } from '../top-n.js';

/** 造一个最小要闻事件视图（仅 eventId 用于断言；其余字段对抑制无关）。 */
function ev(eventId: string): SelectedEvent {
  return {
    eventId,
    representativeTitle: `t-${eventId}`,
    summaryZh: null,
    headlineZh: null,
    canonicalUrl: null,
    publishedAt: null,
    rankScore: 0,
  };
}

/** 造 EventWithKeys（三键默认全 null，只覆盖测试需要的键）。 */
function withKeys(
  eventId: string,
  keys: Partial<EventWithKeys['keys']> = {},
): EventWithKeys {
  return {
    event: ev(eventId),
    keys: {
      canonicalDomain: keys.canonicalDomain ?? null,
      githubRepo: keys.githubRepo ?? null,
      productHuntSlug: keys.productHuntSlug ?? null,
    },
  };
}

/** 造产品三键集合（缺省全空集合）。 */
function keySets(sets: Partial<{
  domains: string[];
  repos: string[];
  slugs: string[];
}> = {}): ProductKeySets {
  return {
    domains: new Set(sets.domains ?? []),
    repos: new Set(sets.repos ?? []),
    slugs: new Set(sets.slugs ?? []),
  };
}

/**
 * 模拟编排层构建产品域集：从全通道候选并集的 canonical_domain 收集、**剔除 PLATFORM_HOSTS**。
 * 单测用它复现「域集已排平台 host」的输入前提（与 run-daily 编排同口径）。
 */
function buildProductDomains(domains: Array<string | null>): Set<string> {
  const out = new Set<string>();
  for (const d of domains) {
    if (d !== null && !PLATFORM_HOSTS.has(d)) out.add(d);
  }
  return out;
}

describe('suppressEventsInProducts', () => {
  it('① canonical_domain 命中 → 剔除（grassdx 类）', () => {
    const events = [
      withKeys('e-grass', { canonicalDomain: 'grassdx.com' }),
      withKeys('e-other', { canonicalDomain: 'unrelated.com' }),
    ];
    const products = keySets({ domains: ['grassdx.com'] });
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual(['e-grass']);
    expect(kept.map((e) => e.eventId)).toEqual(['e-other']);
  });

  it('② github_repo 命中 → 剔除（github 直链类，闭合 news↔product 双段重复）', () => {
    const events = [
      withKeys('e-gh', { canonicalDomain: null, githubRepo: 'owner/repo' }),
    ];
    const products = keySets({ repos: ['owner/repo'] });
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual(['e-gh']);
    expect(kept).toEqual([]);
  });

  it('③ github 来源要闻不被 mass 误抑制：repo 不同 + 域均 null → 保留（防 round-1 blocker）', () => {
    // 事件键 {domain:null（github.com 已被 extractProductMergeKeys 置 null）, repo:'aaa/bbb'}
    // vs 产品集 {repos:{'ccc/ddd'}} → repo 不同、无域键 → 不抑制。
    const events = [
      withKeys('e-gh-news', { canonicalDomain: null, githubRepo: 'aaa/bbb' }),
    ];
    const products = keySets({ repos: ['ccc/ddd'] });
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual([]);
    expect(kept.map((e) => e.eventId)).toEqual(['e-gh-news']);
  });

  it('④ 平台 host 不致误抑制：产品域集排除 PLATFORM_HOSTS 后，含该域的产品不误抑制要闻', () => {
    // 多个 denylist host 都验证：无 website 的产品其 canonical_domain 落成平台 host；
    // 编排层构建产品域集时剔除全部 PLATFORM_HOSTS → 事件即便域 = 该平台 host 也不被误抑制。
    for (const host of ['producthunt.com', 'gitlab.com', 'npmjs.com', 'huggingface.co']) {
      const events = [withKeys(`e-${host}`, { canonicalDomain: host })];
      // 产品候选的 canonical_domain 也落成该平台 host（无 website 兜底 URL）。
      const products: ProductKeySets = {
        domains: buildProductDomains([host]), // 经排除后域集为空。
        repos: new Set(),
        slugs: new Set(),
      };
      const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
      expect(suppressedEventIds, `${host} 不应误抑制`).toEqual([]);
      expect(kept.map((e) => e.eventId)).toEqual([`e-${host}`]);
    }
  });

  it('⑤ product_hunt_slug 命中 → 剔除', () => {
    const events = [
      withKeys('e-ph', { canonicalDomain: null, productHuntSlug: 'cool-tool' }),
    ];
    const products = keySets({ slugs: ['cool-tool'] });
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual(['e-ph']);
    expect(kept).toEqual([]);
  });

  it('⑥ 三键全不命中 → 保留', () => {
    const events = [
      withKeys('e-keep', {
        canonicalDomain: 'site.com',
        githubRepo: 'me/proj',
        productHuntSlug: 'slug-x',
      }),
    ];
    const products = keySets({
      domains: ['other.com'],
      repos: ['you/other'],
      slugs: ['slug-y'],
    });
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual([]);
    expect(kept.map((e) => e.eventId)).toEqual(['e-keep']);
  });

  it('⑦ 事件无键（三键全 null，url 为 null）→ 保留（空键不参与命中）', () => {
    const events = [withKeys('e-nokey')]; // 三键全 null。
    // 即便产品集非空（含空串等），全 null 键也绝不命中。
    const products = keySets({ domains: ['site.com'], repos: ['a/b'], slugs: ['s'] });
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual([]);
    expect(kept.map((e) => e.eventId)).toEqual(['e-nokey']);
  });

  it('⑧ 产品集全空 → 全保留', () => {
    const events = [
      withKeys('e1', { canonicalDomain: 'a.com' }),
      withKeys('e2', { githubRepo: 'x/y' }),
      withKeys('e3', { productHuntSlug: 's' }),
    ];
    const products = keySets(); // domains/repos/slugs 皆空集。
    const { kept, suppressedEventIds } = suppressEventsInProducts(events, products);
    expect(suppressedEventIds).toEqual([]);
    expect(kept.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('不修改入参、返回新数组（同一批输入多次调用结果一致）', () => {
    const events = Object.freeze([
      withKeys('e-grass', { canonicalDomain: 'grassdx.com' }),
      withKeys('e-keep', { canonicalDomain: 'keep.com' }),
    ]);
    const products = keySets({ domains: ['grassdx.com'] });
    const r1 = suppressEventsInProducts(events, products);
    const r2 = suppressEventsInProducts(events, products);
    expect(r1.suppressedEventIds).toEqual(r2.suppressedEventIds);
    expect(r1.kept.map((e) => e.eventId)).toEqual(r2.kept.map((e) => e.eventId));
    // 入参未被改动（Object.freeze 已保证；这里再断言长度不变）。
    expect(events).toHaveLength(2);
  });
});
