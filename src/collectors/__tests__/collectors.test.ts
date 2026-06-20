/**
 * Collector 单元测试（任务 4.5）——纯 mock，不触网、不依赖 DB。
 *
 * 覆盖关键不变量：
 * - source_item_id fallback 链：guid → canonical_url → sha256(title‖content)，绝不为 NULL。
 * - 三源映射到统一结构（source/source_item_id/url/title/content/published_at/raw_type）。
 * - 单源失败不拖垮整批（collectAllSources 用 Promise.allSettled 隔离）。
 * - withRetry：有限重试 + 每次失败记日志，重试耗尽抛出。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

// 各 collector 经 ../index.js 间接 import env（启动期校验）。注入占位 env 后再动态 import。
let mod: typeof import('../index.js');
let typesMod: typeof import('../types.js');
let rssMod: typeof import('../rss.js');
let hnMod: typeof import('../hacker-news.js');
let ghMod: typeof import('../github.js');
let arxivMod: typeof import('../arxiv.js');
let normMod: typeof import('../../dedup/normalize.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  mod = await import('../index.js');
  typesMod = await import('../types.js');
  rssMod = await import('../rss.js');
  hnMod = await import('../hacker-news.js');
  ghMod = await import('../github.js');
  arxivMod = await import('../arxiv.js');
  normMod = await import('../../dedup/normalize.js');
});

describe('contentHash 终端 fallback', () => {
  it('同 title+content 恒同哈希，非空', () => {
    const a = typesMod.contentHash('OpenAI 发布', 'body');
    const b = typesMod.contentHash('OpenAI 发布', 'body');
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });
  it('content 缺失也产出非空哈希', () => {
    expect(typesMod.contentHash('title only', null).length).toBe(64);
  });
});

describe('RSS source_item_id fallback 链 + vendor provenance（命名空间化 guid）', () => {
  const FEED = 'https://openai.com/news/rss.xml';

  it('有 guid → 命名空间化 sha256(feed_url ‖ NUL ‖ guid)（非裸 guid）', () => {
    const out = rssMod.mapRssItem(
      {
        guid: 'guid-123',
        link: 'https://example.com/a?utm_source=x',
        title: 'T',
        content: 'C',
      },
      FEED,
      'openai',
    );
    // 命名空间化后是 64 位 sha256，而非裸 guid。
    expect(out.sourceItemId).toBe(normMod.sha256Hex(`${FEED}\0guid-123`));
    expect(out.sourceItemId).not.toBe('guid-123');
    expect(out.sourceItemId.length).toBe(64);
    expect(out.source).toBe('rss');
    expect(out.rawType).toBe('news');
    // vendor / feed_url 落 metadata。
    expect(out.metadata).toEqual({ vendor: 'openai', feed_url: FEED });
  });

  it('不同 feed 的相同 guid 命名空间化后不冲突（各自独立 id）', () => {
    const feedA = 'https://openai.com/news/rss.xml';
    const feedB = 'https://deepmind.google/blog/rss.xml';
    const a = rssMod.mapRssItem({ guid: 'g-1', title: 'TA' }, feedA, 'openai');
    const b = rssMod.mapRssItem({ guid: 'g-1', title: 'TB' }, feedB, 'deepmind');
    expect(a.sourceItemId).not.toBe(b.sourceItemId);
  });

  it('同 feed 同 guid 命名空间化后稳定一致（源内幂等不破）', () => {
    const a = rssMod.mapRssItem({ guid: 'g-7', title: 'X' }, FEED, 'openai');
    const b = rssMod.mapRssItem({ guid: 'g-7', title: 'Y' }, FEED, 'openai');
    expect(a.sourceItemId).toBe(b.sourceItemId);
  });

  it('未配 vendor → metadata.vendor 取 null，不报错', () => {
    const out = rssMod.mapRssItem({ guid: 'g', title: 'T' }, FEED, null);
    expect(out.metadata).toEqual({ vendor: null, feed_url: FEED });
  });

  it('无 guid → 回退即时生成的 canonical_url（去追踪参数，全局唯一不受命名空间影响）', () => {
    const out = rssMod.mapRssItem(
      { link: 'https://example.com/a?utm_source=x&id=1', title: 'T', content: 'C' },
      FEED,
      'openai',
    );
    expect(out.sourceItemId).toBe('https://example.com/a?id=1');
  });

  it('guid 与 canonical_url 皆缺 → 终端回退内容哈希，绝不为 NULL', () => {
    const out = rssMod.mapRssItem({ link: null, title: 'T', content: 'C' }, FEED, null);
    expect(out.sourceItemId).toBe(typesMod.contentHash('T', 'C'));
    expect(out.sourceItemId.length).toBe(64);
  });

  it('空标题 + 空 URL + 空内容仍得非空 source_item_id', () => {
    const out = rssMod.mapRssItem({ title: '', link: null, content: null }, FEED, null);
    expect(out.sourceItemId.length).toBe(64);
    expect(out.sourceItemId).not.toBe('');
  });

  it('collectRss：feed 的 vendor 入 metadata，guid 命名空间化', async () => {
    const fetchFeed = async () => ({ items: [{ guid: 'g-1', title: 'OpenAI 发布', link: 'https://o/a' }] });
    const items = await rssMod.collectRss({
      feeds: [{ url: FEED, vendor: 'openai' }],
      fetchFeed,
      maxAttempts: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.metadata).toEqual({ vendor: 'openai', feed_url: FEED });
    expect(items[0]!.sourceItemId).toBe(normMod.sha256Hex(`${FEED}\0g-1`));
  });
});

describe('Hacker News 映射', () => {
  it('source_item_id 用 item id（字符串化）', () => {
    const out = hnMod.mapHackerNewsItem({
      id: 42,
      title: 'Show HN',
      url: 'https://x.com',
      time: 1_700_000_000,
    });
    expect(out.sourceItemId).toBe('42');
    expect(out.source).toBe('hacker_news');
    expect(out.rawType).toBe('post');
    expect(out.publishedAt).toBeInstanceOf(Date);
  });

  it('collectHackerNews：单条 item 失败不拖垮整批', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('topstories.json')) return [1, 2, 3];
      if (url.endsWith('/item/2.json')) throw new Error('boom');
      const id = Number(url.match(/item\/(\d+)/)![1]);
      return { id, title: `t${id}`, url: `https://x/${id}`, time: 1 };
    });
    const logError = vi.fn();
    const items = await hnMod.collectHackerNews({
      fetchJson,
      logError,
      maxAttempts: 1,
    });
    // id=2 失败被跳过，1 和 3 成功。
    expect(items.map((i) => i.sourceItemId).sort()).toEqual(['1', '3']);
    expect(logError).toHaveBeenCalled();
  });

  it('collectHackerNews：帖式前缀（Show/Ask/Launch/Tell HN）在 collect 层跳过、记日志，仅普通新闻发射', async () => {
    // id 1–4 为四类帖式帖、id 5 为普通新闻；过滤发生在 collect 层（mapHackerNewsItem 之前），
    // map 本身不变。
    const titles: Record<number, string> = {
      1: 'Show HN: My AI lawn diagnosis app',
      2: 'Ask HN: How do you test LLM apps?',
      3: 'Launch HN: Acme (YC W26) launches',
      4: 'Tell HN: site is down',
      5: 'OpenAI ships X',
    };
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('topstories.json')) return [1, 2, 3, 4, 5];
      const id = Number(url.match(/item\/(\d+)/)![1]);
      return { id, title: titles[id], url: `https://x/${id}`, time: 1 };
    });
    const logError = vi.fn();
    const items = await hnMod.collectHackerNews({
      fetchJson,
      logError,
      maxAttempts: 1,
    });
    // 仅普通新闻（id=5）发射；四条帖式帖被跳过。
    expect(items.map((i) => i.sourceItemId)).toEqual(['5']);
    expect(items[0]!.rawType).toBe('post');
    expect(items[0]!.source).toBe('hacker_news');
    // 四条跳过均记日志（每条一次）。
    expect(logError).toHaveBeenCalledTimes(4);
  });
});

describe('isHackerNewsNonNewsPost 纯函数（行首帖式前缀识别）', () => {
  const PREFIXES = ['Show', 'Ask', 'Launch', 'Tell'];
  // 各分隔符 + 大小写不敏感：HN 帖标题常见形态。
  const SEPARATORS = [': foo', ' - foo', ' – foo', ' — foo', ' foo', ''];

  for (const prefix of PREFIXES) {
    for (const sep of SEPARATORS) {
      const title = `${prefix} HN${sep}`;
      it(`命中：${JSON.stringify(title)}`, () => {
        expect(typesMod.isHackerNewsNonNewsPost(title)).toBe(true);
      });
    }
  }

  it('大小写不敏感（show hn / SHOW HN 均命中）', () => {
    expect(typesMod.isHackerNewsNonNewsPost('show hn: foo')).toBe(true);
    expect(typesMod.isHackerNewsNonNewsPost('SHOW HN: foo')).toBe(true);
    expect(typesMod.isHackerNewsNonNewsPost('aSk Hn - bar')).toBe(true);
  });

  it('前导空白仍命中（^\\s* 锚定）', () => {
    expect(typesMod.isHackerNewsNonNewsPost('   Show HN: foo')).toBe(true);
  });

  it('正文中部含 "Show HN" 不误命中（仅行首锚定）', () => {
    expect(
      typesMod.isHackerNewsNonNewsPost('Why "Show HN" matters for AI startups'),
    ).toBe(false);
  });

  it('"Show HNx" 无词边界不误命中（\\b 要求 HN 后是词边界）', () => {
    expect(typesMod.isHackerNewsNonNewsPost('Show HNx new product')).toBe(false);
  });

  it('空字符串 / null / undefined 返回 false（不抛）', () => {
    expect(typesMod.isHackerNewsNonNewsPost('')).toBe(false);
    expect(typesMod.isHackerNewsNonNewsPost(null)).toBe(false);
    expect(typesMod.isHackerNewsNonNewsPost(undefined)).toBe(false);
  });

  it('非帖式普通标题返回 false', () => {
    expect(typesMod.isHackerNewsNonNewsPost('OpenAI ships X')).toBe(false);
    expect(typesMod.isHackerNewsNonNewsPost('Hacker News redesign')).toBe(false);
  });
});

describe('GitHub 映射', () => {
  it('source_item_id 用数值 repo id（稳定，不随改名变）', () => {
    const out = ghMod.mapGitHubRepo({
      id: 99,
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
      description: 'desc',
      pushed_at: '2026-06-01T00:00:00Z',
      stargazers_count: 123,
    });
    expect(out.sourceItemId).toBe('99');
    expect(out.source).toBe('github');
    expect(out.rawType).toBe('repo');
    expect(out.metadata).toEqual({ stargazers_count: 123 });
  });

  it('无数值 id → 回退 full_name', () => {
    const out = ghMod.mapGitHubRepo({ full_name: 'owner/repo' });
    expect(out.sourceItemId).toBe('owner/repo');
  });

  it('collectGitHub：带 token 时加 Authorization 头', async () => {
    const fetchJson = vi.fn(async (_url: string, headers: Record<string, string>) => {
      expect(headers.Authorization).toBe('Bearer tok');
      return { items: [{ id: 1, full_name: 'a/b', html_url: 'https://github.com/a/b' }] };
    });
    const items = await ghMod.collectGitHub({ fetchJson, token: 'tok', maxAttempts: 1 });
    expect(items).toHaveLength(1);
    expect(fetchJson).toHaveBeenCalled();
  });

  it('collectGitHub：匿名（空 token）不加 Authorization 头', async () => {
    const fetchJson = vi.fn(async (_url: string, headers: Record<string, string>) => {
      expect(headers.Authorization).toBeUndefined();
      return { items: [] };
    });
    await ghMod.collectGitHub({ fetchJson, token: '', maxAttempts: 1 });
    expect(fetchJson).toHaveBeenCalled();
  });
});

describe('withRetry', () => {
  it('首次失败后重试成功', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    const logError = vi.fn();
    const result = await typesMod.withRetry(fn, { maxAttempts: 3, logError });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽抛出，每次失败记日志（非静默）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    const logError = vi.fn();
    await expect(
      typesMod.withRetry(fn, { maxAttempts: 3, logError }),
    ).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(3);
  });
});

const rssItem = {
  source: 'rss' as const,
  sourceItemId: 'r1',
  url: 'https://x/1',
  title: 'rss item',
  content: null,
  publishedAt: null,
  rawType: 'news',
};
const hnItem = {
  source: 'hacker_news' as const,
  sourceItemId: 'h1',
  url: null,
  title: 'hn item',
  content: null,
  publishedAt: null,
  rawType: 'post',
};

describe('collectAllSources / registry：单源失败不拖垮整批', () => {
  it('GitHub 抛错时其余源照常返回，perSource 标记失败（arxiv 单源失败被隔离）', async () => {
    const result = await mod.collectAllSources({
      logError: () => {},
      collectors: {
        rss: async () => [rssItem],
        hackerNews: async () => [hnItem],
        github: async () => {
          throw new Error('GitHub 限流');
        },
        // arXiv 单源失败（如 429 达上限放弃）也被 allSettled 隔离，不拖垮整批、不触发全失败。
        arxiv: async () => {
          throw new Error('arXiv 429 放弃');
        },
        // product_hunt / show_hn 注入空桩，隔离真实 PH GraphQL / HN Algolia（漏桩会拉真数据污染断言）。
        productHunt: async () => [],
        showHn: async () => [],
        // add-tier1-ai-sources：两新源同理注入空桩，避免漏桩落真实 HF JSON API / sitemap 污染断言。
        hfPapers: async () => [],
        sitemap: async () => [],
      },
    });
    expect(result.items.map((i) => i.sourceItemId).sort()).toEqual(['h1', 'r1']);
    expect(result.perSource.rss?.ok).toBe(true);
    expect(result.perSource.hacker_news?.ok).toBe(true);
    expect(result.perSource.github?.ok).toBe(false);
    expect(result.perSource.github?.error).toBeInstanceOf(Error);
    expect(result.perSource.arxiv?.ok).toBe(false);
    // RSS/HN 成功 → items 非空 → 不触发「全部源返回 0」告警。
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('全部源挂 → items 为空（编排层据此告警）', async () => {
    const fail = async () => {
      throw new Error('down');
    };
    const result = await mod.collectAllSources({
      logError: () => {},
      // 全部 registry 源都注入桩（含 product_hunt / show_hn），避免漏桩源落到真实网络（带真实
      // PRODUCT_HUNT_TOKEN / HN Algolia 时会拉到真数据使「items 为空」断言失败）。
      collectors: {
        rss: fail,
        hackerNews: fail,
        github: fail,
        arxiv: fail,
        productHunt: fail,
        showHn: fail,
        // add-tier1-ai-sources：两新源也注入桩，避免漏桩落真实 HF JSON API / sitemap 网络。
        hfPapers: fail,
        sitemap: fail,
      },
    });
    expect(result.items).toHaveLength(0);
    expect(result.perSource.rss?.ok).toBe(false);
    expect(result.perSource.hacker_news?.ok).toBe(false);
    expect(result.perSource.github?.ok).toBe(false);
    expect(result.perSource.arxiv?.ok).toBe(false);
    expect(result.perSource.product_hunt?.ok).toBe(false);
    expect(result.perSource.show_hn?.ok).toBe(false);
    expect(result.perSource.hugging_face_papers?.ok).toBe(false);
    expect(result.perSource.sitemap?.ok).toBe(false);
  });

  it('registry 注册即接入：新增一源后被并发调用（buildRegistry 含全部 source）', () => {
    const registry = mod.buildRegistry({});
    const sources = registry.map((e) => e.source).sort();
    expect(sources).toEqual([
      'arxiv',
      'blogger',
      'github',
      'hacker_news',
      'hugging_face_papers',
      'product_hunt',
      'rss',
      'show_hn',
      'sitemap',
    ]);
  });

  it('registry 各源并发调用（非串行）：所有 collect 同时在跑', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = (id: string) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return [{ ...rssItem, source: 'rss' as const, sourceItemId: id }];
    };
    await mod.collectAllSources({
      logError: () => {},
      collectors: {
        rss: slow('a'),
        hackerNews: slow('b'),
        github: slow('c'),
        arxiv: slow('d'),
        productHunt: slow('e'),
        showHn: slow('f'),
        hfPapers: slow('g'),
        sitemap: slow('h'),
      },
    });
    // 并发执行 → 同时在跑的源数 > 1（若串行则恒为 1）。
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});

describe('collectSources：按 source 筛选子集（实时新闻源）', () => {
  it('只跑 {rss, hacker_news, github}，不触 arXiv', async () => {
    const arxivSpy = vi.fn(async () => []);
    const result = await mod.collectSources(mod.REALTIME_NEWS_SOURCES, {
      logError: () => {},
      collectors: {
        rss: async () => [rssItem],
        hackerNews: async () => [hnItem],
        github: async () => [],
        arxiv: arxivSpy,
      },
    });
    // arXiv 不在子集 → 其 collector 从未被调用（高频链路不被迫连 arXiv 跑）。
    expect(arxivSpy).not.toHaveBeenCalled();
    expect(Object.keys(result.perSource).sort()).toEqual([
      'github',
      'hacker_news',
      'rss',
    ]);
    expect(result.perSource.arxiv).toBeUndefined();
  });
});

describe('子集意图负向断言（MINOR-2）：两新源不进实时/产品子集', () => {
  it('REALTIME_NEWS_SOURCES 不含 hugging_face_papers / sitemap（非实时）', () => {
    expect(mod.REALTIME_NEWS_SOURCES).not.toContain('hugging_face_papers');
    expect(mod.REALTIME_NEWS_SOURCES).not.toContain('sitemap');
  });
  it('PRODUCT_SOURCES 不含 hugging_face_papers / sitemap（非产品）', () => {
    expect(mod.PRODUCT_SOURCES).not.toContain('hugging_face_papers');
    expect(mod.PRODUCT_SOURCES).not.toContain('sitemap');
  });
});

describe('arXiv collector（OAI-PMH 节流 / 退避 / 游标 at-least-once）', () => {
  const RECORD_XML = (id: string, ds = '2026-06-10') => `
    <record>
      <header><identifier>oai:arXiv.org:${id}</identifier><datestamp>${ds}</datestamp></header>
      <metadata><dc>
        <dc:title>A paper ${id}</dc:title>
        <dc:description>abstract text</dc:description>
        <dc:identifier>https://arxiv.org/abs/${id}</dc:identifier>
      </dc></metadata>
    </record>`;
  const LIST = (body: string, token = '') => `<?xml version="1.0"?>
    <OAI-PMH><ListRecords>${body}${
      token ? `<resumptionToken>${token}</resumptionToken>` : ''
    }</ListRecords></OAI-PMH>`;

  it('解析为 paper + collapsed=true + 稳定 arXiv id + source=arxiv', async () => {
    arxivMod.__resetArxivThrottleForTest();
    const items = await arxivMod.collectArxiv({
      fetchText: async () => LIST(RECORD_XML('2406.12345')),
      sleep: async () => {},
      now: () => 0,
      maxPages: 1,
    });
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.source).toBe('arxiv');
    expect(it0.rawType).toBe('paper');
    expect(it0.collapsed).toBe(true);
    expect(it0.sourceItemId).toBe('oai:arXiv.org:2406.12345');
    expect(it0.url).toBe('https://arxiv.org/abs/2406.12345');
  });

  it('节流：相邻请求间隔 ≥3s 串行（翻页时第二请求等待）', async () => {
    arxivMod.__resetArxivThrottleForTest();
    let clock = 0;
    const waits: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms);
      clock += ms; // 模拟时间推进。
    });
    let calls = 0;
    const fetchText = async () => {
      calls++;
      // 模拟每次请求瞬时返回但时间未推进（除 sleep 外），第一页带 token → 触发第二页。
      return calls === 1
        ? LIST(RECORD_XML('1'), 'tok')
        : LIST(RECORD_XML('2'));
    };
    await arxivMod.harvestArxiv({
      fetchText,
      sleep,
      now: () => clock,
      maxPages: 2,
      minIntervalMs: 3000,
    });
    expect(calls).toBe(2);
    // 第二次请求前节流闸要求等待 ≥3000ms（第一次 clock=0 立即放行）。
    expect(waits.some((w) => w >= 3000)).toBe(true);
  });

  it('429 退避重试且达上限放弃：本轮该源抛出（由 allSettled 隔离）', async () => {
    arxivMod.__resetArxivThrottleForTest();
    const fetchText = vi.fn(async () => {
      throw new arxivMod.ArxivRateLimitError('429');
    });
    await expect(
      arxivMod.harvestArxiv({
        fetchText,
        sleep: async () => {},
        now: () => 0,
        maxAttempts: 3,
        backoffBaseMs: 1,
      }),
    ).rejects.toThrow();
    // 达上限：尝试 maxAttempts 次后放弃（非无界）。
    expect(fetchText).toHaveBeenCalledTimes(3);
  });

  it('401/403 鉴权错误不重试，直接抛出隔离', async () => {
    arxivMod.__resetArxivThrottleForTest();
    const fetchText = vi.fn(async () => {
      throw new arxivMod.ArxivAuthError(403, '403 forbidden');
    });
    await expect(
      arxivMod.harvestArxiv({
        fetchText,
        sleep: async () => {},
        now: () => 0,
        maxAttempts: 4,
        backoffBaseMs: 1,
      }),
    ).rejects.toBeInstanceOf(arxivMod.ArxivAuthError);
    // 鉴权错误不进入退避重试：只调用一次（不浪费重试预算）。
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('游标 at-least-once：harvest 期间绝不推进游标，仅入库后调 commit 才推进', async () => {
    arxivMod.__resetArxivThrottleForTest();
    let stored: Date | null = null;
    const cursor = {
      load: async () => null,
      commit: vi.fn(async (to: Date) => {
        stored = to;
      }),
    };
    const result = await arxivMod.harvestArxiv({
      fetchText: async () => LIST(RECORD_XML('1', '2026-06-09')),
      sleep: async () => {},
      now: () => 0,
      cursor,
      maxPages: 1,
    });
    // harvest 返回后游标尚未推进（commit 未被调用）。
    expect(cursor.commit).not.toHaveBeenCalled();
    expect(stored).toBeNull();
    expect(result.nextCursor?.toISOString().slice(0, 10)).toBe('2026-06-09');

    // 编排层在「入库成功」后才调 commit → 此刻才推进。
    await result.commit();
    expect(cursor.commit).toHaveBeenCalledOnce();
    expect((stored as unknown as Date)?.toISOString().slice(0, 10)).toBe('2026-06-09');
  });

  it('稳定 arXiv id 源内幂等：同一论文重复 harvest 得相同 source_item_id', async () => {
    arxivMod.__resetArxivThrottleForTest();
    const one = await arxivMod.collectArxiv({
      fetchText: async () => LIST(RECORD_XML('2406.99999')),
      sleep: async () => {},
      now: () => 0,
      maxPages: 1,
    });
    arxivMod.__resetArxivThrottleForTest();
    const two = await arxivMod.collectArxiv({
      fetchText: async () => LIST(RECORD_XML('2406.99999')),
      sleep: async () => {},
      now: () => 0,
      maxPages: 1,
    });
    expect(one[0]!.sourceItemId).toBe(two[0]!.sourceItemId);
  });
});

describe('arXiv 固定回溯窗口游标接线（at-least-once：窗口重叠 + UNIQUE，commit no-op）', () => {
  let cursorMod: typeof import('../arxiv-cursor.js');
  beforeAll(async () => {
    cursorMod = await import('../arxiv-cursor.js');
  });

  it('load() 返回 now − LOOKBACK_DAYS（保守 7 天回溯窗口下界）', async () => {
    const fixedNow = Date.UTC(2026, 5, 11, 12, 0, 0); // 2026-06-11 12:00 UTC
    const store = cursorMod.createLookbackArxivCursorStore(
      cursorMod.ARXIV_LOOKBACK_DAYS,
      () => fixedNow,
    );
    const from = await store.load();
    expect(from).not.toBeNull();
    // now − 7d = 2026-06-04（OAI-PMH from 取日期段）。
    expect(from!.toISOString().slice(0, 10)).toBe('2026-06-04');
  });

  it('commit() 是 no-op（固定窗口不持久化游标，无可推进状态、可安全重复调用）', async () => {
    const store = cursorMod.createLookbackArxivCursorStore(7, () => 0);
    // 不抛错、无副作用即合格（无持久化状态可破坏，故 crash-safe）。
    await expect(store.commit(new Date())).resolves.toBeUndefined();
    await expect(store.commit(new Date())).resolves.toBeUndefined();
  });

  it('接入 harvestArxiv：注入回溯游标后首请求带 from=回溯窗口下界（按窗口增量、非每轮全量）', async () => {
    arxivMod.__resetArxivThrottleForTest();
    const fixedNow = Date.UTC(2026, 5, 11, 12, 0, 0);
    const store = cursorMod.createLookbackArxivCursorStore(7, () => fixedNow);
    const urls: string[] = [];
    await arxivMod.harvestArxiv({
      fetchText: async (url: string) => {
        urls.push(url);
        return `<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>`;
      },
      sleep: async () => {},
      now: () => 0,
      cursor: store,
      maxPages: 1,
    });
    expect(urls).toHaveLength(1);
    // from 取 now−7d 的日期段（2026-06-04），证明按回溯窗口增量采集而非每轮全量（无 from）。
    expect(urls[0]).toContain('from=2026-06-04');
  });
});
