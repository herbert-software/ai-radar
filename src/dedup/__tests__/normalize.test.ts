/**
 * 规范化纯函数单测（任务 3.4）——纯逻辑，无 DB / 无 LLM / 无网络。
 *
 * 覆盖 spec 三个验收点：
 * 1. 带 utm 的两 URL 归一为同一 canonical_url（追踪参数被移除、query 排序、host 小写、去尾斜杠）。
 * 2. 仅噪声词不同的两标题得同一 title_hash（小写/去标点/去 emoji/去站点名/繁简/去噪声词）。
 * 3. normalizer_version 随结果产出（写入 metadata 由 collapse 层做，本测断言结果对象带版本号）。
 */
import { describe, expect, it } from 'vitest';
import {
  NORMALIZER_VERSION,
  buildDedupKey,
  computeTitleHash,
  normalizeRawItem,
  normalizeTitle,
  normalizeUrl,
  sha256Hex,
} from '../normalize.js';

describe('normalizeUrl', () => {
  it('移除 utm/ref/spm 等追踪参数后两 URL 归一为同一 canonical_url', () => {
    const a = normalizeUrl(
      'https://Example.com/path/?utm_source=twitter&utm_medium=social&id=42&ref=hn',
    );
    const b = normalizeUrl(
      'https://example.com/path?id=42&spm=abc&fbclid=xyz&gclid=123',
    );
    expect(a).toBe('https://example.com/path?id=42');
    expect(a).toBe(b);
  });

  it('query 参数排序使顺序不影响指纹', () => {
    expect(normalizeUrl('https://x.com/a?b=2&a=1')).toBe(
      normalizeUrl('https://x.com/a?a=1&b=2'),
    );
  });

  it('去 fragment、host 小写、去尾斜杠', () => {
    expect(normalizeUrl('HTTPS://EXAMPLE.COM/Foo/#section')).toBe(
      'https://example.com/Foo',
    );
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('空 / 非法 / 非 http(s) → null', () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
  });
});

describe('normalizeTitle / title_hash', () => {
  it('仅噪声词/标点/大小写不同的两标题得同一 title_hash', () => {
    const h1 = computeTitleHash('【重磅】OpenAI Releases GPT-5!!!');
    const h2 = computeTitleHash('快讯 openai releases gpt-5');
    expect(h1).not.toBeNull();
    expect(h1).toBe(h2);
  });

  it('emoji 与尾部站点名被剥离后 title_hash 相同', () => {
    const h1 = computeTitleHash('🚀 OpenAI 发布新模型 - 36氪');
    const h2 = computeTitleHash('OpenAI 发布新模型');
    expect(h1).toBe(h2);
  });

  it('紧贴的连字符正文（GPT-4）不被当站点名剥离', () => {
    const n = normalizeTitle('GPT-4');
    expect(n).toContain('4');
    expect(n).not.toBe('gpt');
  });

  it('两侧带空格的分隔符（标题 - 站点名）仍剥离站点名', () => {
    expect(normalizeTitle('OpenAI 发布新模型 - 36氪')).toBe(
      normalizeTitle('OpenAI 发布新模型'),
    );
  });

  it('繁简转换：繁体与简体同标题得同一 title_hash', () => {
    // 用纯字形对应的繁简对（發佈會→发布会、開發→开发），不涉及词汇差异（如 智慧/智能）。
    const trad = computeTitleHash('開發者大會發佈');
    const simp = computeTitleHash('开发者大会发布');
    expect(trad).toBe(simp);
  });

  it('标题仅由 emoji/标点/噪声词构成 → 归一为空串、title_hash 为 null', () => {
    expect(normalizeTitle('🚀🚀！！！')).toBe('');
    expect(normalizeTitle('【重磅】')).toBe('');
    expect(computeTitleHash('🚀！！')).toBeNull();
    expect(computeTitleHash('')).toBeNull();
    expect(computeTitleHash(null)).toBeNull();
  });

  it('title_hash = sha256(normalized_title)', () => {
    const raw = 'Hello World';
    const normalized = normalizeTitle(raw);
    expect(computeTitleHash(raw)).toBe(sha256Hex(normalized));
  });
});

describe('buildDedupKey fallback 链', () => {
  it('有 canonical_url → sha256(canonical_url)', () => {
    const url = 'https://example.com/a';
    expect(buildDedupKey(url, 'sometitlehash')).toBe(sha256Hex(url));
  });

  it('无 canonical_url 但有 title_hash → sha256(title_hash)', () => {
    const th = sha256Hex('normalized title');
    expect(buildDedupKey(null, th)).toBe(sha256Hex(th));
  });

  it('皆缺 → null', () => {
    expect(buildDedupKey(null, null)).toBeNull();
  });
});

describe('normalizeRawItem 聚合产物', () => {
  it('结果对象携带 normalizer_version', () => {
    const r = normalizeRawItem({ url: 'https://x.com/a', title: 'Hello' });
    expect(r.normalizerVersion).toBe(NORMALIZER_VERSION);
    expect(r.unprocessable).toBe(false);
    expect(r.dedupKey).toBe(sha256Hex('https://x.com/a'));
  });

  it('无 URL 且标题归一为空 → unprocessable=true, dedupKey=null', () => {
    const r = normalizeRawItem({ url: null, title: '🚀！！' });
    expect(r.canonicalUrl).toBeNull();
    expect(r.titleHash).toBeNull();
    expect(r.dedupKey).toBeNull();
    expect(r.unprocessable).toBe(true);
  });

  it('无 URL 但标题可归一 → 用 title_hash 兜底 dedupKey', () => {
    const r = normalizeRawItem({ url: null, title: 'OpenAI 发布新模型' });
    expect(r.canonicalUrl).toBeNull();
    expect(r.titleHash).not.toBeNull();
    expect(r.unprocessable).toBe(false);
    expect(r.dedupKey).toBe(sha256Hex(r.titleHash!));
  });
});
