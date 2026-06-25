/**
 * allowlist ↔ seed-data 漂移守卫（M5，design D10）。
 *
 * `seed-data.ts` 里 `fetchStrategy∈{http,browser}` 的源会被抓取链触达，其 host registrable domain
 * 必须 ∈ `MR_SOURCE_DOMAIN_ALLOWLIST`，否则录入/抓取被白名单拒、变更检测静默不跑。
 * `manual` 档不抓取，不在守护范围。
 *
 * 纯逻辑（两文件均无 import 副作用），无 DB / 网络 / LLM / env。
 */
import { describe, expect, it } from 'vitest';
import { isHostAllowlisted } from '../allowlist.js';
import { SEED_VENDORS } from '../../ingest/seed-data.js';

/** seed-data 中所有会被抓取（http/browser）的源 host。 */
const scrapedHosts = [
  ...new Set(
    SEED_VENDORS.flatMap((v) =>
      v.sources
        .filter((s) => s.fetchStrategy === 'http' || s.fetchStrategy === 'browser')
        .map((s) => new URL(s.sourceUrl).hostname),
    ),
  ),
];

describe('M5 allowlist ↔ seed-data 漂移守卫', () => {
  it('seed-data 至少有一个 http/browser 源（守卫非空）', () => {
    expect(scrapedHosts.length).toBeGreaterThan(0);
  });

  it.each(scrapedHosts)('seed http/browser 源 host %s 过白名单', (host) => {
    expect(isHostAllowlisted(host)).toBe(true);
  });

  it('manual 源即便不在白名单也不被守卫要求（豁免语义，design D10）', () => {
    // manual 源不发请求、豁免录入闸；漂移守卫只约束 http/browser 源，不强制 manual host 入白名单。
    const manualHosts = SEED_VENDORS.flatMap((v) =>
      v.sources
        .filter((s) => s.fetchStrategy === 'manual')
        .map((s) => new URL(s.sourceUrl).hostname),
    );
    const nonAllowlistedManual = manualHosts.filter((h) => !isHostAllowlisted(h));
    // seed 里至少有一个 manual 源（MiMo）host 不在白名单，且守卫不据此报漂移。
    expect(nonAllowlistedManual.length).toBeGreaterThan(0);
  });
});
