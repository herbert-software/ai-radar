/**
 * sitemap 增量采集器单元测试（add-tier1-ai-sources 任务 7.2，**纯 mock 不触网、不连库**）。
 *
 * 注入桩：fetchText（sitemap XML）/ fetchArticle（按 url 返文章 HTML）/ querySeenCanonicalUrls
 * （DB 已见集）/ now（钉死参考时刻使窗判定确定）/ windowDays。覆盖不变量（spec / design D3）：
 * - lastmod 窗过滤（窗内取 / 窗外跳 / lastmod 缺失·NaN 跳，M-4）。
 * - 已见集命中跳过、不重复 fetch（querySeen 返含某 canonical → 该 url 的 fetchArticle 不被调用）。
 * - og:title→title / og:description→content 正则提取（经 collectSitemaps 路径间接覆盖；
 *   extractOgTag 在 sitemap.ts 未导出，故不直接单测，改由集成路径断言提取结果）。
 * - og:title 缺失 → deriveTitleFromUrl slug 回退（title 非空）；og 双缺 → 跳过该篇不发射（M-1）。
 * - published_at===null 且 metadata.lastmod 落值（lastmod 不进 published_at，M-C）。
 * - source='sitemap' / metadata.vendor / rawType='news' / source_item_id===canonical（正常）。
 * - len>255 的 url → source_item_id 折叠为 contentHash（64 hex、≠ url，F-6）。
 * - loc_count=0（2xx 空解析）→ 整源抛出（不返回空数组 success，M-A）。
 * - 已见集查询失败 → 整源抛出（不降级空集致全量 fetch，F-4）。
 * - 畸形/相对 loc（normalizeUrl 返 null）过滤阶段跳过（F-5/A-4）。
 * - pathPrefix 用 pathname.startsWith（query-string 含 /news/ 不误纳入，G-6）。
 * - 跨 vendor 唯一（两条不同 vendor/域名 → source_item_id 互不相等且均为完整 canonical URL，G-12）。
 * - 单篇 fetchArticle 失败（重试耗尽）→ 跳过该篇、其余照常；整源 fetchText 失败 → 抛出。
 * - 纯函数 parseSitemap / extractOgTag / deriveTitleFromUrl 单元断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SitemapSourceConfig } from '../../config/env.js';

/** 一天毫秒（FIX-8 测试构造未来 lastmod 用；sitemap.ts 内部同名常量不导出，此处本地定义）。 */
const MS_PER_DAY = 86_400_000;

let mod: typeof import('../sitemap.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  // 纯净 CI 无 .env 时 env.ts module-load 会因缺 PRODUCT_HUNT_TOKEN throw（FIX-3，比照 product-hunt.test.ts）。
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  mod = await import('../sitemap.js');
});

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

/** 钉死参考时刻 + 3 天窗 → 下界 2026-06-11T00:00:00Z。 */
const NOW = new Date('2026-06-14T00:00:00Z');
const WINDOW_DAYS = 3;

const ANTHROPIC_CONFIG: SitemapSourceConfig = {
  sitemapUrl: 'https://www.anthropic.com/sitemap.xml',
  pathPrefix: '/news/',
  vendor: 'anthropic',
};

/** 文章 HTML 路由：按 canonical url 返对应 fixture（命中文章页则返完整 og、其余返无 og）。 */
function articleRouter(html: string = fixture('anthropic-article.html')) {
  return async (_url: string) => html;
}

// ── 纯函数单元断言 ────────────────────────────────────────────────────────

describe('parseSitemap 纯函数', () => {
  it('先 match <url> 块、再块内取 loc/lastmod；无 loc 块不计入', () => {
    const entries = mod.parseSitemap(fixture('anthropic-sitemap.xml'));
    // fixture 共 7 个 <url> 块（均有 loc）→ 7 条。
    expect(entries).toHaveLength(7);
    const byLoc = new Map(entries.map((e) => [e.loc, e.lastmod]));
    // 缺 lastmod 的 url 块 → lastmod 为 null（不与下一个 url 的 lastmod 错位配对）。
    expect(byLoc.get('https://www.anthropic.com/news/no-lastmod-entry')).toBeNull();
    expect(byLoc.get('https://www.anthropic.com/news/claude-opus-4-launch')).toBe(
      '2026-06-13T10:00:00+00:00',
    );
  });

  it('缺 lastmod 的 url 不窃取后续 url 的 lastmod（块隔离）', () => {
    const xml = `<urlset>
      <url><loc>https://a.com/one</loc></url>
      <url><loc>https://a.com/two</loc><lastmod>2026-06-13</lastmod></url>
    </urlset>`;
    const entries = mod.parseSitemap(xml);
    expect(entries).toEqual([
      { loc: 'https://a.com/one', lastmod: null },
      { loc: 'https://a.com/two', lastmod: '2026-06-13' },
    ]);
  });

  it('结构异常/无 <url> → 空数组', () => {
    expect(mod.parseSitemap('<html><body>not a sitemap</body></html>')).toEqual([]);
  });
});

describe('deriveTitleFromUrl 纯函数', () => {
  it('取末段 slug、把 -/_ 折空格、词首大写', () => {
    expect(
      mod.deriveTitleFromUrl('https://www.anthropic.com/news/claude-opus-4-launch'),
    ).toBe('Claude Opus 4 Launch');
  });
  it('畸形 URL → 回退整串（不抛）', () => {
    expect(mod.deriveTitleFromUrl('not a url')).toBe('not a url');
  });
});

// ── collectSitemaps 集成路径 ───────────────────────────────────────────────

describe('collectSitemaps lastmod 窗过滤 + 路径前缀', () => {
  it('窗内 /news/ 取，窗外/缺 lastmod/NaN/非 /news/ 路径 跳', async () => {
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () => fixture('anthropic-sitemap.xml'),
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    // 候选只剩两条窗内未见的 /news/（claude-opus-4-launch + already-seen-article，
    // 本用例 querySeen 返空 → 两条都未见）。
    const fetched = fetchArticle.mock.calls.map((c) => c[0]).sort();
    expect(fetched).toEqual([
      'https://www.anthropic.com/news/already-seen-article',
      'https://www.anthropic.com/news/claude-opus-4-launch',
    ]);
    // 窗外（old-archived-post）/ 缺 lastmod（no-lastmod-entry）/ 非 /news/（research）/
    // careers?redirect=/news/（pathname=/careers）/ 相对 loc 均未被 fetch。
    expect(fetched).not.toContain('https://www.anthropic.com/news/old-archived-post');
    expect(fetched).not.toContain('https://www.anthropic.com/news/no-lastmod-entry');
    expect(fetched.some((u) => u.includes('/research/'))).toBe(false);
    expect(fetched.some((u) => u.includes('/careers'))).toBe(false);
    // 两篇文章 HTML 均含完整 og → 均发射。
    expect(items).toHaveLength(2);
  });
});

describe('collectSitemaps 已见集去重（不重复 fetch）', () => {
  it('querySeen 返含某 canonical → 该 url 的 fetchArticle 不被调用', async () => {
    const seenUrl = 'https://www.anthropic.com/news/already-seen-article';
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () => fixture('anthropic-sitemap.xml'),
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set([seenUrl]),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    const fetched = fetchArticle.mock.calls.map((c) => c[0]);
    // 已见 url 绝不被 fetch（spy 计数验证）。
    expect(fetched).not.toContain(seenUrl);
    // 仅剩未见的一条 claude-opus-4-launch 被 fetch + 发射。
    expect(fetched).toEqual(['https://www.anthropic.com/news/claude-opus-4-launch']);
    expect(items.map((i) => i.url)).toEqual([
      'https://www.anthropic.com/news/claude-opus-4-launch',
    ]);
  });
});

describe('collectSitemaps og 提取与映射', () => {
  async function collectOne(html: string) {
    return mod.collectSitemaps({
      // 单条窗内 /news/ 的精简 sitemap，隔离断言到一篇。
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/claude-opus-4-launch</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => html,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
  }

  it('og:title→title / og:description→content；映射 source/vendor/rawType/source_item_id', async () => {
    const items = await collectOne(fixture('anthropic-article.html'));
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.source).toBe('sitemap');
    expect(it0.rawType).toBe('news');
    expect(it0.title).toBe('Introducing Claude Opus 4');
    expect(it0.content).toBe(
      'Claude Opus 4 is our most capable model, with state-of-the-art coding and reasoning.',
    );
    expect(it0.url).toBe('https://www.anthropic.com/news/claude-opus-4-launch');
    // 正常 url（len<=255）→ source_item_id === canonical_url。
    expect(it0.sourceItemId).toBe('https://www.anthropic.com/news/claude-opus-4-launch');
    expect(it0.metadata?.vendor).toBe('anthropic');
    expect(it0.metadata?.feed_url).toBe('https://www.anthropic.com/sitemap.xml');
  });

  it('published_at===null 且 metadata.lastmod 落值（lastmod 不进 published_at）', async () => {
    const items = await collectOne(fixture('anthropic-article.html'));
    const it0 = items[0]!;
    expect(it0.publishedAt).toBeNull();
    expect(it0.metadata?.lastmod).toBe('2026-06-13T10:00:00Z');
  });

  it('og:title 缺失但有 og:description → slug 回退非空 title', async () => {
    const items = await collectOne(fixture('anthropic-article-no-og-title.html'));
    expect(items).toHaveLength(1);
    // og:title 缺失 → deriveTitleFromUrl('.../claude-opus-4-launch')。
    expect(items[0]!.title).toBe('Claude Opus 4 Launch');
    expect(items[0]!.title.length).toBeGreaterThan(0);
    expect(items[0]!.content).toBe(
      'A description present without any accompanying og:title tag.',
    );
  });

  it('og:title 缺失 + slug 含 %00/%07/lone-surrogate 百分号编码 → strip 危险字符、正常字符保留、非空', async () => {
    // 第 4 轮 Major：deriveTitleFromUrl 回退路径调 decodeURIComponent(slug)，把 %00/%07/%EF%BF%BF
    // 解成原始 NUL/C0 控制符/lone surrogate；该路径不经 stripUnsafeChars（上轮只覆盖 og content 路径）
    // → title 含 NUL → store.ts 直插 Postgres text 列致 INSERT 中止整批。修复后 decode→strip。
    const evilSlug = 'evil%00slug%07ctrl%EF%BF%BFx'; // %EF%BF%BF=U+FFFF（百分号编码 ASCII，无字面控制字节）。
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/${evilSlug}</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      // og:title 缺、og:description 在 → 触发 deriveTitleFromUrl 回退（非 M-1 双缺跳过）。
      fetchArticle: async () => fixture('anthropic-article-no-og-title.html'),
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    expect(items).toHaveLength(1);
    const title = items[0]!.title;
    // 不含 NUL/C0 控制符 / lone surrogate（最危险的 Postgres-破坏字符）。
    expect(title).not.toMatch(
      // eslint-disable-next-line no-control-regex -- 测试断言：检测控制字符是否被净化
      new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\ud800-\\udfff]'),
    );
    expect(title.length).toBeGreaterThan(0);
    // 正常字符保留（危险字符剔除后相连）。
    expect(title.toLowerCase()).toContain('evil');
    expect(title.toLowerCase()).toContain('slug');
    expect(title.toLowerCase()).toContain('ctrl');
  });

  it('content-first 顺序 + 前置含 content= 的 meta → 不跨标签误匹配（逐标签提取）', async () => {
    // fixture 前置 `<meta property="og:type" content="article" />`，随后是 content-first 顺序的
    // og:title/og:description。原 content-first 正则会跨标签回溯成 `article" />…`；修复后应取标签内真值。
    const items = await collectOne(fixture('anthropic-article-content-first.html'));
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.title).toBe('Real Content-First Title');
    expect(it0.content).toBe('Real desc');
  });
});

describe('collectSitemaps source_item_id 长度折叠（F-6）', () => {
  it('len>255 的 url → source_item_id 折叠 contentHash（64 hex、≠ url）', async () => {
    // 构造一条 pathname 超长（>255）的 /news/ URL。
    const longSlug = 'a'.repeat(300);
    const longUrl = `https://www.anthropic.com/news/${longSlug}`;
    expect(longUrl.length).toBeGreaterThan(255);
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>${longUrl}</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => fixture('anthropic-article.html'),
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    // url 仍为完整 canonical（长 url），但 source_item_id 折叠为 64 位 contentHash。
    expect(it0.url).toBe(longUrl);
    expect(it0.sourceItemId).not.toBe(longUrl);
    expect(it0.sourceItemId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('collectSitemaps pathPrefix 用 pathname.startsWith（非 includes）', () => {
  it('query-string 含 /news/ 但 pathname 非 /news/ 开头 → 不误纳入', async () => {
    const trickyUrl = 'https://www.anthropic.com/careers?redirect=/news/secret';
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>${trickyUrl}</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    // pathname=/careers → 不匹配 /news/ → 整源无窗内候选 → loc_count>0 但 0 emit（正常无新文）。
    expect(fetchArticle).not.toHaveBeenCalled();
    expect(items).toEqual([]);
  });
});

describe('collectSitemaps 跨 vendor 唯一（G-12）', () => {
  it('两条不同 vendor/域名 loc → source_item_id 互不相等且均为完整 canonical URL（非裸 slug）', async () => {
    const cfgA: SitemapSourceConfig = {
      sitemapUrl: 'https://www.anthropic.com/sitemap.xml',
      pathPrefix: '/news/',
      vendor: 'anthropic',
    };
    const cfgB: SitemapSourceConfig = {
      sitemapUrl: 'https://lab-b.example.com/sitemap.xml',
      pathPrefix: '/news/',
      vendor: 'lab_b',
    };
    // 两源同 slug（articles 名相同）但域名不同 → canonical 不同。
    const xmlFor = (host: string) =>
      `<urlset><url><loc>https://${host}/news/shared-slug</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`;
    const items = await mod.collectSitemaps({
      sources: [cfgA, cfgB],
      fetchText: async (url) =>
        url.includes('anthropic')
          ? xmlFor('www.anthropic.com')
          : xmlFor('lab-b.example.com'),
      fetchArticle: async () => fixture('anthropic-article.html'),
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.sourceItemId);
    // 跨 vendor 互不相等。
    expect(ids[0]).not.toBe(ids[1]);
    // 均为完整 canonical URL（含域名），非裸 slug。
    for (const it of items) {
      expect(it.sourceItemId).toBe(it.url);
      expect(it.sourceItemId).toMatch(/^https:\/\/[^/]+\/news\/shared-slug$/);
    }
    // 含两个域名。
    expect(ids.some((id) => id.includes('anthropic.com'))).toBe(true);
    expect(ids.some((id) => id.includes('lab-b.example.com'))).toBe(true);
  });
});

describe('collectSitemaps 畸形/相对 loc 过滤（F-5）', () => {
  it('normalizeUrl 返 null 的相对/非 http loc 在过滤阶段跳过、不发射', async () => {
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset>
          <url><loc>/relative/news/broken</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url>
          <url><loc>mailto:x@y.com</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url>
          <url><loc>https://www.anthropic.com/news/valid-one</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url>
        </urlset>`,
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    const fetched = fetchArticle.mock.calls.map((c) => c[0]);
    // 仅合法 http(s) 的 /news/ loc 被纳入；畸形/相对/非 http 全部跳过。
    expect(fetched).toEqual(['https://www.anthropic.com/news/valid-one']);
    expect(items).toHaveLength(1);
  });
});

describe('collectSitemaps loc_count=0 判源失败（M-A）', () => {
  it('2xx 但无 <url> 的 XML → 整源抛出（不返回空数组 success）', async () => {
    await expect(
      mod.collectSitemaps({
        sources: [ANTHROPIC_CONFIG],
        fetchText: async () => '<?xml version="1.0"?><urlset></urlset>',
        fetchArticle: async () => fixture('anthropic-article.html'),
        querySeenCanonicalUrls: async () => new Set(),
        now: NOW,
        windowDays: WINDOW_DAYS,
        maxAttempts: 1,
        logError: () => {},
      }),
    ).rejects.toThrow(/loc_count=0/);
  });
});

describe('collectSitemaps 已见集查询失败 → 整源抛出（F-4）', () => {
  it('querySeen 抛错 → 整源抛出，不降级空集致全量 fetch', async () => {
    const fetchArticle = vi.fn(articleRouter());
    await expect(
      mod.collectSitemaps({
        sources: [ANTHROPIC_CONFIG],
        fetchText: async () => fixture('anthropic-sitemap.xml'),
        fetchArticle,
        querySeenCanonicalUrls: async () => {
          throw new Error('DB unreachable');
        },
        now: NOW,
        windowDays: WINDOW_DAYS,
        logError: () => {},
      }),
    ).rejects.toThrow('DB unreachable');
    // 关键：已见集查询失败时绝不降级空集后全量重抓 → fetchArticle 一篇都没调。
    expect(fetchArticle).not.toHaveBeenCalled();
  });
});

describe('collectSitemaps 单篇/整源失败隔离', () => {
  it('单篇 fetchArticle 失败（重试耗尽）→ 跳过该篇、其余照常', async () => {
    const badUrl = 'https://www.anthropic.com/news/claude-opus-4-launch';
    const goodUrl = 'https://www.anthropic.com/news/already-seen-article';
    const fetchArticle = vi.fn(async (url: string) => {
      if (url === badUrl) throw new Error('article 500');
      return fixture('anthropic-article.html');
    });
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () => fixture('anthropic-sitemap.xml'),
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      maxAttempts: 2,
      baseDelayMs: 0,
      sleep: async () => {},
      logError: () => {},
    });
    // 坏篇跳过、好篇照常发射（不拖垮该源）。
    expect(items.map((i) => i.url)).toEqual([goodUrl]);
  });

  it('整源 fetchText 失败（重试耗尽）→ 抛出', async () => {
    let calls = 0;
    await expect(
      mod.collectSitemaps({
        sources: [ANTHROPIC_CONFIG],
        fetchText: async () => {
          calls += 1;
          throw new Error('sitemap 503');
        },
        fetchArticle: async () => fixture('anthropic-article.html'),
        querySeenCanonicalUrls: async () => new Set(),
        now: NOW,
        windowDays: WINDOW_DAYS,
        maxAttempts: 3,
        baseDelayMs: 0,
        sleep: async () => {},
        logError: () => {},
      }),
    ).rejects.toThrow('sitemap 503');
    expect(calls).toBe(3);
  });
});

// ── FIX-1：XML/HTML 实体解码（数字字符引用 + 命名实体 + 防双解码） ───────────────

describe('collectSitemaps XML 实体解码（FIX-1：数字字符引用先解、&amp; 最后、防双解码）', () => {
  async function collectOne(html: string) {
    return mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/claude-opus-4-launch</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => html,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
  }

  it('og:title 的 &#x27; 解为 \'；og:description 的 &amp; 与 &#x2014; 正确解码（无双解码）', async () => {
    const items = await collectOne(fixture('anthropic-article-entities.html'));
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    // &#x27; → 单引号（数字字符引用解码）。危险码点（&#0;/&#7;/&#xD800;）被剔为空串、不破坏正常字符序列。
    expect(it0.title).toBe("Anthropic's Responsible Scaling Policy");
    // &amp; → &（命名实体），&#x2014; → em dash —（数字字符引用）。
    expect(it0.content).toBe('Safety & governance — our framework for scaling responsibly.');
  });

  it('FIX-B：&#0;/&#7;/&#xD800; 被剔——title/content 不含 NUL/控制字符/lone surrogate', async () => {
    // fixture 的 og:title/og:description 嵌入 &#0;（NUL）/&#7;（C0 控制符）/&#xD800;（lone surrogate）。
    // safeFromCodePoint 将其全部剔为空串：防 NUL 致 Postgres text INSERT 失败（store 阶段非 allSettled 隔离、中止整批）、
    // 防 lone surrogate 破坏下游 JSON.stringify。
    const items = await collectOne(fixture('anthropic-article-entities.html'));
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    // 不含 NUL/C0 控制字符（保留 tab/LF/CR 外）。
    // eslint-disable-next-line no-control-regex
    const dangerousControl = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
    expect(it0.title).not.toMatch(dangerousControl);
    expect(it0.content).not.toMatch(dangerousControl);
    // 不含 lone surrogate（U+D800–U+DFFF）。
    const loneSurrogate = /[\uD800-\uDFFF]/;
    expect(it0.title).not.toMatch(loneSurrogate);
    expect(it0.content).not.toMatch(loneSurrogate);
    // 正常字符仍正确（&#x27;→'、&amp;→&、em dash），不受危险码点剔除影响。
    expect(it0.title).toBe("Anthropic's Responsible Scaling Policy");
    expect(it0.content).toBe('Safety & governance — our framework for scaling responsibly.');
    // NUL 字面量绝不出现（最危险的 Postgres-破坏字符）。
    expect(it0.title.includes('\x00')).toBe(false);
    expect(it0.content!.includes('\x00')).toBe(false);
  });
});

// ── FIX-5：og content 空串 → null（M-1 双缺 guard 对 content="" 也触发） ──────────

describe('collectSitemaps og content="" 视同缺失（FIX-5）', () => {
  it('og:title 与 og:description 均 content="" → 该篇被跳过不发射（M-1）', async () => {
    const html = `<!DOCTYPE html><html><head>
      <meta property="og:title" content="" />
      <meta property="og:description" content="" />
    </head><body></body></html>`;
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/claude-opus-4-launch</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => html,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    expect(items).toEqual([]);
  });
});

// ── FIX-7：SSRF host 限制（文章 host 须 === sitemap host 或其子域） ────────────────

describe('collectSitemaps SSRF host 限制（FIX-7）', () => {
  it('文章 host 为内网/元数据/外域 → 跳过该 loc、不对其调 fetchArticle', async () => {
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset>
          <url><loc>https://169.254.169.254/news/metadata</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url>
          <url><loc>https://evil.com/news/exfil</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url>
          <url><loc>https://www.anthropic.com/news/legit</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url>
        </urlset>`,
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    const fetched = fetchArticle.mock.calls.map((c) => c[0]);
    // 仅同 host 的 /news/ 被纳入；内网/元数据/外域全部跳过。
    expect(fetched).toEqual(['https://www.anthropic.com/news/legit']);
    expect(fetched).not.toContain('https://169.254.169.254/news/metadata');
    expect(fetched).not.toContain('https://evil.com/news/exfil');
    expect(items).toHaveLength(1);
  });

  it('文章 host 为 sitemap host 的子域 → 放行', async () => {
    const cfg: SitemapSourceConfig = {
      sitemapUrl: 'https://anthropic.com/sitemap.xml',
      pathPrefix: '/news/',
      vendor: 'anthropic',
    };
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [cfg],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/sub</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    // www.anthropic.com 是 anthropic.com 的子域 → 放行。
    expect(fetchArticle.mock.calls.map((c) => c[0])).toEqual([
      'https://www.anthropic.com/news/sub',
    ]);
    expect(items).toHaveLength(1);
  });
});

// ── FIX-8：lastmod 窗口上界（未来 lastmod 不入窗） ───────────────────────────────

describe('collectSitemaps lastmod 窗口上界（FIX-8：未来 lastmod 不采）', () => {
  it('lastmod 为 now+1 天（未来）→ 不入窗、不 fetch、不发射', async () => {
    const future = new Date(NOW.getTime() + MS_PER_DAY).toISOString();
    const fetchArticle = vi.fn(articleRouter());
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/future-post</loc><lastmod>${future}</lastmod></url></urlset>`,
      fetchArticle,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    // loc_count>0（解析出 1 条）但未来 lastmod 被上界挡住 → 无窗内候选 → 0 emit（正常无新文，不抛）。
    expect(fetchArticle).not.toHaveBeenCalled();
    expect(items).toEqual([]);
  });
});

// ── FIX-2：ReDoS 加界 + body 上限 + content-type 闸 ─────────────────────────────

describe('parseSitemap ReDoS（indexOf 线性扫描：未闭合 <url> 大畸形 body 线性、不二次方回溯）', () => {
  // 块切分改 indexOf 线性扫描（非 lazy 捕获正则）：未闭合 <url> 立即 break、不重复 scan-to-EOF。
  // 旧 lazy 捕获正则 `<url[^>]*>([\s\S]{0,100000}?)</url>` 在未闭合大 body 上仍二次方（实测 1MB→29s、
  // 2MB→60s，5MB body 上限内即卡死 worker）；indexOf 线性后 5MB→7ms 量级。

  it('2MB 未闭合 <url> 的畸形 XML → < 500ms 完成、解析 0 条（无闭合→0 条）', () => {
    // ~2MB：旧 lazy 捕获正则在此即 ~60s 二次方卡死；indexOf 线性扫描应毫秒级完成。
    const malformed = '<urlset>' + '<url>x'.repeat(350_000) + '</urlset>';
    expect(malformed.length).toBeGreaterThan(2 * 1024 * 1024);
    const t0 = Date.now();
    const entries = mod.parseSitemap(malformed);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // 线性，严格时限；旧实现此处会二次方卡死。
    expect(entries).toEqual([]); // 无闭合 </url> → 0 条（经 collectSitemaps 会因 loc_count=0 抛源失败）。
  });

  it('合法闭合 <url> 块内含 ~1MB 未闭合 <loc> → < 500ms（firstChildTag 残留二次方回溯防护）', () => {
    // FIX-A：indexOf 切块绕不开此攻击——<url>...</url> 合法闭合，但块内塞海量未闭合 <loc>。
    // 旧 firstChildTag 的 `<loc>([\s\S]{0,100000}?)</loc>` lazy 捕获在此仍二次方（实测 1MB→29.6s）。
    // 新「开标签有界匹配 + 找闭合 + slice」线性，毫秒级；缺闭合 </loc> → loc 返 null → 该块不计入。
    const unclosedLoc = '<loc>x'.repeat(180_000); // ~1MB 未闭合 <loc>。
    const malformed = `<urlset><url>${unclosedLoc}</url></urlset>`;
    expect(malformed.length).toBeGreaterThan(1024 * 1024);
    const t0 = Date.now();
    const entries = mod.parseSitemap(malformed);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // 旧实现此处会二次方卡死（~13.9s+）。
    expect(entries).toEqual([]); // 块内无闭合 </loc> → firstChildTag('loc') 返 null → 不计入。
  });

  it('合法闭合 <url> 块内含 ~1MB 未闭合开标签 spam（无 >：<loc<loc...）→ < 500ms（FIX-A1 开标签 [^>]* scan-to-EOF 二次方消除）', () => {
    // 第 3 轮 finding：旧 firstChildTag 的 `<(?:[\w-]+:)?loc\b[^>]*>` 在「无 '>' 的 <loc 重复」上，
    // 每个 '<' 起点让 [^>]* 贪婪扫到串尾再失败 = O(n²)（实测 <loc×40000 无 > → 2976ms）。
    // 新 indexOf：第一次找不到 '>' 立即 return null，线性。
    const unclosedSpam = '<loc'.repeat(270_000); // >1MB，全是无 '>' 的 <loc。
    const malformed = `<urlset><url>${unclosedSpam}</url></urlset>`;
    expect(malformed.length).toBeGreaterThan(1024 * 1024);
    const t0 = Date.now();
    const entries = mod.parseSitemap(malformed);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // 严格时限；旧 [^>]* scan-to-EOF 在此二次方卡死。
    expect(entries).toEqual([]); // 块内无任何闭合标签 → firstChildTag('loc') 返 null → 不计入。
  });

  it('正常 <loc>/<lastmod> 与命名空间 <image:loc> 仍正确解析（FIX-A 不破坏正向）', () => {
    const xml = `<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url>
        <image:loc>https://www.anthropic.com/news/ns-prefixed</image:loc>
        <lastmod>2026-06-13T10:00:00+00:00</lastmod>
      </url>
    </urlset>`;
    const entries = mod.parseSitemap(xml);
    // 命名空间前缀 <image:loc> 由 firstChildTag 的 `(?:[\w-]+:)?` 宽松匹配。
    expect(entries).toEqual([
      {
        loc: 'https://www.anthropic.com/news/ns-prefixed',
        lastmod: '2026-06-13T10:00:00+00:00',
      },
    ]);
  });
});

// ── FIX-A2：extractOgTag 开标签 ReDoS（文章 HTML 含 ~1MB 未闭合 <meta spam，无 >） ──────

describe('extractOgTag 开标签 ReDoS（经 collectSitemaps：~1MB 未闭合 <meta 无 > → 线性、不二次方）', () => {
  it('文章 HTML 含 ~1MB 未闭合 <meta spam（无 >）→ < 500ms、og 取不到 → M-1 跳过该篇（0 条）', async () => {
    // 第 3 轮 finding：旧 `<meta\b[^>]*>` 在「无 '>' 的 <meta 重复」上 O(n²)（实测 <meta×40000 → 3698ms）。
    // 新 indexOf：第一个 <meta 找不到 '>' 立即 return null，线性。
    // spam 在前且无 '>' → extractOgTag 对 og:title/og:description 均立即 null（碰到第一个无 '>' 的 <meta 即 bail）
    // → M-1 双缺跳过该篇 → 0 条。load-bearing 断言：无 '>' spam 不致二次方（< 500ms）。
    const metaSpam = '<meta'.repeat(220_000); // >1MB，全是无 '>' 的 <meta。
    const html =
      `<!DOCTYPE html><html><head>${metaSpam}` +
      `<meta property="og:description" content="Never reached past the no-'>' spam." />` +
      `</head><body></body></html>`;
    expect(html.length).toBeGreaterThan(1024 * 1024);
    const t0 = Date.now();
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/claude-opus-4-launch</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => html,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // 严格时限；旧 <meta\b[^>]* scan-to-EOF 在此二次方卡死。
    // 无 '>' spam → og 取不到 → M-1 双缺跳过该篇。
    expect(items).toEqual([]);
  });

  it('正常 <meta> + 尾随 ~1MB 未闭合 <meta spam（无 >）→ < 500ms 且正常提取 og（FIX-A2 不破坏正向）', async () => {
    // 有效 og 标签在前（带 '>'），尾随无 '>' spam：linear 扫描先命中真值正常发射，
    // 即使后续有海量无 '>' spam 也不二次方（命中后即返回；且 boundary/indexOf 对 spam 也线性）。
    const metaSpam = '<meta'.repeat(220_000); // >1MB，无 '>'。
    const html =
      `<!DOCTYPE html><html><head>` +
      `<meta property="og:title" content="Linear Extract Works" />` +
      `<meta property="og:description" content="Valid desc before spam." />` +
      `${metaSpam}</head><body></body></html>`;
    expect(html.length).toBeGreaterThan(1024 * 1024);
    const t0 = Date.now();
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/claude-opus-4-launch</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => html,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Linear Extract Works');
    expect(items[0]!.content).toBe('Valid desc before spam.');
  });
});

// ── FIX-B：原始 NUL/控制字节/lone surrogate 出口剔除（绕过 safeFromCodePoint 实体路径） ──

describe('collectSitemaps 原始危险字节出口剔除（FIX-B：og content 里的原始 NUL/控制符/lone surrogate）', () => {
  it('og content 含原始 NUL/C0 控制符/lone surrogate（非实体）→ 提取结果剔除危险字符、正常字符无损', async () => {
    // 第 3 轮 finding：safeFromCodePoint 只防**实体**路径；og content 里的**原始**字节直穿。
    // 字面控制字节不写进源文件 → 用 String.fromCharCode 在测试内构造 fixture 字符串。
    const NUL = String.fromCharCode(0);
    const C0 = String.fromCharCode(7); // BEL（C0 控制符）。
    const LONE_HI = String.fromCharCode(0xd800); // lone high surrogate。
    const TAB = String.fromCharCode(9); // 保留：\t 不应被剔。
    const dangerousTitle = `Clean${NUL}Ti${C0}tle${LONE_HI}${TAB}End`;
    const dangerousDesc = `Safe${NUL} desc${LONE_HI} with${TAB}tab`;
    const html =
      `<!DOCTYPE html><html><head>` +
      `<meta property="og:title" content="${dangerousTitle}" />` +
      `<meta property="og:description" content="${dangerousDesc}" />` +
      `</head><body></body></html>`;
    const items = await mod.collectSitemaps({
      sources: [ANTHROPIC_CONFIG],
      fetchText: async () =>
        `<urlset><url><loc>https://www.anthropic.com/news/claude-opus-4-launch</loc><lastmod>2026-06-13T10:00:00Z</lastmod></url></urlset>`,
      fetchArticle: async () => html,
      querySeenCanonicalUrls: async () => new Set(),
      now: NOW,
      windowDays: WINDOW_DAYS,
      logError: () => {},
    });
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    // 不含 NUL/C0 控制符（保留 \t\n\r 外）与 lone surrogate。
    // eslint-disable-next-line no-control-regex -- 测试断言：检测控制字符是否被净化
    const dangerous = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\ud800-\\udfff]');
    expect(it0.title).not.toMatch(dangerous);
    expect(it0.content!).not.toMatch(dangerous);
    // 危险字符被剔后正常字符相连，\t 保留。
    expect(it0.title).toBe(`CleanTitle${TAB}End`);
    expect(it0.content).toBe(`Safe desc with${TAB}tab`);
    // NUL 字面量绝不出现（最危险的 Postgres-破坏字符）。
    expect(it0.title.includes(NUL)).toBe(false);
    expect(it0.content!.includes(NUL)).toBe(false);
  });
});

describe('defaultFetchText / defaultFetchArticle content-type + body 上限闸（FIX-2）', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(opts: {
    ok?: boolean;
    contentType?: string;
    contentLength?: string | null;
    body: string;
  }) {
    globalThis.fetch = (async () => ({
      ok: opts.ok ?? true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase();
          if (key === 'content-type') return opts.contentType ?? null;
          if (key === 'content-length') return opts.contentLength ?? null;
          return null;
        },
      },
      text: async () => opts.body,
    })) as unknown as typeof fetch;
  }

  it('defaultFetchText：content-type=application/json → 抛出（非 XML 闸）', async () => {
    mockFetch({ contentType: 'application/json', body: '{"error":"x"}' });
    await expect(
      mod.defaultFetchText('https://www.anthropic.com/sitemap.xml'),
    ).rejects.toThrow(/content-type 非 XML/);
  });

  it('defaultFetchText：content-type 含 xml 且 body 正常 → 返回 body', async () => {
    mockFetch({
      contentType: 'application/xml; charset=utf-8',
      body: '<urlset></urlset>',
    });
    await expect(
      mod.defaultFetchText('https://www.anthropic.com/sitemap.xml'),
    ).resolves.toBe('<urlset></urlset>');
  });

  it('defaultFetchText：body 超 5MB（content-length 撒谎为小，实际超界）→ 抛出', async () => {
    const huge = 'a'.repeat(5 * 1024 * 1024 + 1);
    mockFetch({ contentType: 'text/xml', contentLength: '10', body: huge });
    await expect(
      mod.defaultFetchText('https://www.anthropic.com/sitemap.xml'),
    ).rejects.toThrow(/超 5242880 字节上限/);
  });

  it('defaultFetchText：content-length 申报超 5MB → 抛出（读前粗筛）', async () => {
    mockFetch({
      contentType: 'text/xml',
      contentLength: String(6 * 1024 * 1024),
      body: '<urlset></urlset>',
    });
    await expect(
      mod.defaultFetchText('https://www.anthropic.com/sitemap.xml'),
    ).rejects.toThrow(/超 5242880 字节上限/);
  });

  it('defaultFetchArticle：content-type=application/json → 抛出（非 HTML 闸）', async () => {
    mockFetch({ contentType: 'application/json', body: '{"x":1}' });
    await expect(
      mod.defaultFetchArticle('https://www.anthropic.com/news/x'),
    ).rejects.toThrow(/content-type 非 HTML/);
  });

  it('defaultFetchArticle：content-type 含 html 且 body 正常 → 返回 body', async () => {
    mockFetch({ contentType: 'text/html; charset=utf-8', body: '<html></html>' });
    await expect(
      mod.defaultFetchArticle('https://www.anthropic.com/news/x'),
    ).resolves.toBe('<html></html>');
  });

  it('defaultFetchArticle：body 超 5MB → 抛出', async () => {
    const huge = 'h'.repeat(5 * 1024 * 1024 + 1);
    mockFetch({ contentType: 'text/html', contentLength: null, body: huge });
    await expect(
      mod.defaultFetchArticle('https://www.anthropic.com/news/x'),
    ).rejects.toThrow(/超 5242880 字节上限/);
  });
});
