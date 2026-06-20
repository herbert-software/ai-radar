/**
 * Blogger Collector 单元测试（add-ai-blogger-experience-mining，任务 2.5）——纯 mock，不触网、不依赖 DB。
 *
 * 覆盖关键不变量（隔离命门 + 字幕增强 + 失败隔离）：
 * - 落库两硬字段：`source='blogger'`/`raw_type='experience'`（**非经 mapRssItem 误写为 'rss'/'news'**）
 *   + `collapsed=true` 确定性写入。
 * - 博主 feed 注册即接入（buildRegistry 含 'blogger'）；blogger **不在** REALTIME_NEWS_SOURCES /
 *   PRODUCT_SOURCES 两子集（对齐既有子集护栏）。
 * - source_item_id fallback 链（命名空间化 guid → canonical_url → 内容哈希），绝不为 NULL；
 *   YouTube Atom 经 rss-parser 原生解析（同形 item），无 guid 时回退 canonical_url（watch URL）。
 * - YouTube 字幕增强：有字幕取 transcript 作 content / 无字幕（库返回空）退化为标题+简介 /
 *   取字幕失败被隔离（注入抛错桩）退化为标题+简介、不中止整批。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let mod: typeof import('../index.js');
let bloggerMod: typeof import('../blogger.js');
let rssMod: typeof import('../rss.js');
let normMod: typeof import('../../dedup/normalize.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  mod = await import('../index.js');
  bloggerMod = await import('../blogger.js');
  rssMod = await import('../rss.js');
  normMod = await import('../../dedup/normalize.js');
});

const BLOG_FEED = 'https://simonwillison.net/atom/everything/';
const YT_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxx';

describe('mapBloggerItem：两硬字段确定性标记（隔离命门）', () => {
  it('产出 source=blogger / raw_type=experience / collapsed=true（绝非 rss/news）', () => {
    const out = bloggerMod.mapBloggerItem(
      { guid: 'post-1', link: 'https://simonwillison.net/2026/a', title: 'T', content: 'C' },
      BLOG_FEED,
      'simonw',
    );
    expect(out.source).toBe('blogger');
    expect(out.rawType).toBe('experience');
    expect(out.collapsed).toBe(true);
    // 反向断言：绝不是 mapRssItem 硬钉的 rss/news。
    expect(out.source).not.toBe('rss');
    expect(out.rawType).not.toBe('news');
  });

  it('与 mapRssItem 同源条目对照：source/raw_type 必不同（证未复用 mapRssItem）', () => {
    const item = { guid: 'g', link: 'https://x/a', title: 'T', content: 'C' };
    const rss = rssMod.mapRssItem(item, BLOG_FEED, 'v');
    const blog = bloggerMod.mapBloggerItem(item, BLOG_FEED, 'v');
    expect(rss.source).toBe('rss');
    expect(rss.rawType).toBe('news');
    expect(blog.source).toBe('blogger');
    expect(blog.rawType).toBe('experience');
  });

  it('vendor / feed_url 落 metadata；未配 vendor → null', () => {
    const withVendor = bloggerMod.mapBloggerItem({ guid: 'g', title: 'T' }, BLOG_FEED, 'simonw');
    expect(withVendor.metadata).toEqual({ vendor: 'simonw', feed_url: BLOG_FEED });
    const noVendor = bloggerMod.mapBloggerItem({ guid: 'g', title: 'T' }, BLOG_FEED, null);
    expect(noVendor.metadata).toEqual({ vendor: null, feed_url: BLOG_FEED });
  });
});

describe('mapBloggerItem：source_item_id fallback 链（绝不为 NULL）', () => {
  it('有 guid → 命名空间化 sha256(feed_url ‖ NUL ‖ guid)（非裸 guid）', () => {
    const out = bloggerMod.mapBloggerItem({ guid: 'g-1', title: 'T' }, BLOG_FEED, 'v');
    expect(out.sourceItemId).toBe(normMod.sha256Hex(`${BLOG_FEED}\0g-1`));
    expect(out.sourceItemId).not.toBe('g-1');
    expect(out.sourceItemId.length).toBe(64);
  });

  it('不同 feed 相同 guid 命名空间化后不冲突', () => {
    const a = bloggerMod.mapBloggerItem({ guid: 'g', title: 'A' }, BLOG_FEED, 'v');
    const b = bloggerMod.mapBloggerItem({ guid: 'g', title: 'B' }, YT_FEED, 'v');
    expect(a.sourceItemId).not.toBe(b.sourceItemId);
  });

  it('YouTube Atom entry 无传统 guid → 回退 canonical_url（watch URL 稳定）', () => {
    // rss-parser 原生归一 Atom 后 link 为 watch URL；entry 无 item.guid 时走 canonical_url fallback。
    const out = bloggerMod.mapBloggerItem(
      { link: 'https://www.youtube.com/watch?v=abc123&utm_source=x', title: 'Vid' },
      YT_FEED,
      'yt',
    );
    expect(out.sourceItemId).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('guid 与 canonical_url 皆缺 → 终端内容哈希，绝不为 NULL', () => {
    const out = bloggerMod.mapBloggerItem({ link: null, title: 'T', content: 'C' }, BLOG_FEED, null);
    expect(out.sourceItemId.length).toBe(64);
    expect(out.sourceItemId).not.toBe('');
  });
});

describe('isYouTubeUrl：host 判定', () => {
  it('youtube.com 及子域为真，其余为假', () => {
    expect(bloggerMod.isYouTubeUrl('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(bloggerMod.isYouTubeUrl('https://youtube.com/watch?v=x')).toBe(true);
    expect(bloggerMod.isYouTubeUrl('https://simonwillison.net/2026/a')).toBe(false);
    expect(bloggerMod.isYouTubeUrl('https://notyoutube.com.evil/x')).toBe(false);
    expect(bloggerMod.isYouTubeUrl(null)).toBe(false);
    expect(bloggerMod.isYouTubeUrl('relative/path')).toBe(false);
  });
});

describe('collectBlogger：落库口径 + 字幕增强 + 失败隔离（注入桩不触网）', () => {
  it('博客 feed（非 YouTube）：不调字幕、取 feed 自带正文、两硬字段落库', async () => {
    const fetchTranscript = vi.fn(async () => 'should-not-be-called');
    const items = await bloggerMod.collectBlogger({
      feeds: [{ url: BLOG_FEED, vendor: 'simonw' }],
      fetchFeed: async () => ({
        items: [{ guid: 'p1', link: 'https://simonwillison.net/2026/a', title: 'Blog T', content: '正文 C' }],
      }),
      fetchTranscript,
      maxAttempts: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('blogger');
    expect(items[0]!.rawType).toBe('experience');
    expect(items[0]!.collapsed).toBe(true);
    expect(items[0]!.content).toBe('正文 C');
    // 非 YouTube 条目绝不触发字幕拉取。
    expect(fetchTranscript).not.toHaveBeenCalled();
  });

  it('有字幕 YouTube 视频：取 transcript 作 content', async () => {
    const fetchTranscript = vi.fn(async () => '字幕全文 transcript body');
    const items = await bloggerMod.collectBlogger({
      feeds: [{ url: YT_FEED, vendor: 'yt' }],
      fetchFeed: async () => ({
        items: [{ link: 'https://www.youtube.com/watch?v=vid1', title: '视频标题', content: '简介' }],
      }),
      fetchTranscript,
      maxAttempts: 1,
    });
    expect(fetchTranscript).toHaveBeenCalledWith('https://www.youtube.com/watch?v=vid1');
    expect(items[0]!.source).toBe('blogger');
    expect(items[0]!.rawType).toBe('experience');
    expect(items[0]!.collapsed).toBe(true);
    // 字幕作正文（取代 feed 简介）。
    expect(items[0]!.content).toBe('字幕全文 transcript body');
  });

  it('无字幕 YouTube 视频（库返回空）：退化为仅标题+简介、不 ASR', async () => {
    const fetchTranscript = vi.fn(async () => '   '); // 空白 → 视作无字幕。
    const items = await bloggerMod.collectBlogger({
      feeds: [{ url: YT_FEED, vendor: 'yt' }],
      fetchFeed: async () => ({
        items: [{ link: 'https://www.youtube.com/watch?v=vid2', title: '无字幕视频', content: '仅简介' }],
      }),
      fetchTranscript,
      maxAttempts: 1,
    });
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    // 退化为 feed 自带简介，仍落两硬字段。
    expect(items[0]!.content).toBe('仅简介');
    expect(items[0]!.source).toBe('blogger');
    expect(items[0]!.rawType).toBe('experience');
  });

  it('取字幕失败被隔离：单条抛错退化为标题+简介、其余条目照常、不中止整批', async () => {
    const logError = vi.fn();
    const fetchTranscript = vi.fn(async (url: string) => {
      if (url.includes('boom')) throw new Error('429 too many requests');
      return '正常字幕';
    });
    const items = await bloggerMod.collectBlogger({
      feeds: [{ url: YT_FEED, vendor: 'yt' }],
      fetchFeed: async () => ({
        items: [
          { link: 'https://www.youtube.com/watch?v=boom', title: '失败视频', content: '简介A' },
          { link: 'https://www.youtube.com/watch?v=ok', title: '成功视频', content: '简介B' },
        ],
      }),
      fetchTranscript,
      logError,
      maxAttempts: 1,
    });
    // 整批未中止：两条都落库。
    expect(items).toHaveLength(2);
    const boom = items.find((i) => i.title === '失败视频')!;
    const ok = items.find((i) => i.title === '成功视频')!;
    // 失败条退化为 feed 简介（非字幕）。
    expect(boom.content).toBe('简介A');
    // 成功条取字幕。
    expect(ok.content).toBe('正常字幕');
    // 失败记错误日志（非静默）。
    expect(logError).toHaveBeenCalled();
  });

  it('字幕抓取挂起（永不 resolve）被超时隔离：不卡死整批、退化为标题+简介', async () => {
    const logError = vi.fn();
    // 永不 resolve/reject 的字幕抓取（模拟底层 HTTP 挂起）——若无超时会卡死整个 collectBlogger。
    const hung = vi.fn(() => new Promise<string>(() => {}));
    const items = await bloggerMod.collectBlogger({
      feeds: [{ url: YT_FEED, vendor: 'yt' }],
      fetchFeed: async () => ({
        items: [
          { link: 'https://www.youtube.com/watch?v=hang', title: '挂起视频', content: '简介H' },
          { link: 'https://www.youtube.com/watch?v=after', title: '后续视频', content: '简介I' },
        ],
      }),
      fetchTranscript: hung,
      logError,
      maxAttempts: 1,
      sleep: async () => {}, // 重试间隔免等。
      transcriptTimeoutMs: 20, // 小超时：挂起 promise 20ms 后被超时 reject。
    });
    // 整批未被挂起条目卡死：两条都落库、后续条目照常处理。
    expect(items).toHaveLength(2);
    const hang = items.find((i) => i.title === '挂起视频')!;
    const after = items.find((i) => i.title === '后续视频')!;
    // 挂起条经超时隔离 → 退化为 feed 简介（非字幕、非卡死）。
    expect(hang.content).toBe('简介H');
    expect(after.content).toBe('简介I');
    expect(hang.source).toBe('blogger');
    expect(hang.rawType).toBe('experience');
    expect(logError).toHaveBeenCalled(); // 超时记错误日志（非静默）。
  });

  it('单 feed 失败不拖垮其余 feed（allSettled 隔离）+ 空 feeds 返回空', async () => {
    const logError = vi.fn();
    const items = await bloggerMod.collectBlogger({
      feeds: [
        { url: 'https://good.example/feed', vendor: 'g' },
        { url: 'https://bad.example/feed', vendor: 'b' },
      ],
      fetchFeed: async (url) => {
        if (url.includes('bad')) throw new Error('feed down');
        return { items: [{ guid: 'g1', link: 'https://good.example/a', title: 'OK' }] };
      },
      logError,
      maxAttempts: 1,
    });
    expect(items.map((i) => i.title)).toEqual(['OK']);
    // 失败 feed 记日志（非静默）。
    expect(logError).toHaveBeenCalled();
    // 空 feeds 短路。
    expect(await bloggerMod.collectBlogger({ feeds: [], maxAttempts: 1 })).toEqual([]);
  });
});

describe('registry 注册即接入 + 子集护栏', () => {
  it('buildRegistry 含 blogger（注册即接入）', () => {
    const sources = mod.buildRegistry({}).map((e) => e.source);
    expect(sources).toContain('blogger');
  });

  it('blogger 经 registry 被并发调用、落 source=blogger 聚合', async () => {
    const result = await mod.collectAllSources({
      logError: () => {},
      collectors: {
        rss: async () => [],
        hackerNews: async () => [],
        github: async () => [],
        arxiv: async () => [],
        productHunt: async () => [],
        showHn: async () => [],
        hfPapers: async () => [],
        sitemap: async () => [],
        blogger: async () => [
          {
            source: 'blogger' as const,
            sourceItemId: 'b1',
            url: 'https://x/a',
            title: 'exp',
            content: 'c',
            publishedAt: null,
            rawType: 'experience',
            collapsed: true,
          },
        ],
      },
    });
    expect(result.perSource.blogger?.ok).toBe(true);
    expect(result.perSource.blogger?.count).toBe(1);
    expect(result.items[0]!.source).toBe('blogger');
  });

  it('blogger 不在 REALTIME_NEWS_SOURCES（非实时）', () => {
    expect(mod.REALTIME_NEWS_SOURCES).not.toContain('blogger');
  });

  it('blogger 不在 PRODUCT_SOURCES（非产品）', () => {
    expect(mod.PRODUCT_SOURCES).not.toContain('blogger');
  });
});
