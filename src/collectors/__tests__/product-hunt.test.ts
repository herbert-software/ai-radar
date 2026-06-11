/**
 * Product Hunt 采集器 + 归一化键提取单元测试（任务 7.5，**纯 mock 不触网、不依赖 DB**）。
 *
 * 覆盖不变量（spec product-discovery / design D1/D4）：
 * - mapProductHuntPost：source='product_hunt'、rawType='product'、PH 原始 payload 入 metadata。
 * - title 兜底链：产品名缺失 → slug → canonical_domain（绝不留空，满足 raw_items.title NOT NULL）。
 * - source_item_id 用 slug（缺失走 canonical_url → 内容哈希），绝不为空。
 * - 鉴权错误 401/403 不重试直接抛出；429 退避重试有上限、超限放弃抛出。
 * - 限流余量耗尽（remaining<=floor）依 Reset 退避而非打满。
 * - extractCanonicalDomain / normalizeGithubRepo / extractProductMergeKeys 归一化纯函数。
 * - PH collector 注册进 registry：单源失败被 allSettled 隔离。
 */
import { beforeAll, describe, expect, it } from 'vitest';

let phMod: typeof import('../product-hunt.js');
let collapseMod: typeof import('../product-collapse.js');
let indexMod: typeof import('../index.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  phMod = await import('../product-hunt.js');
  collapseMod = await import('../product-collapse.js');
  indexMod = await import('../index.js');
});

const okHeaders = { rateLimitRemaining: 5000, rateLimitResetSeconds: null };

function bodyWith(nodes: unknown[]): unknown {
  return { data: { posts: { edges: nodes.map((node) => ({ node })) } } };
}

describe('mapProductHuntPost 映射统一结构', () => {
  it('完整产品：source/rawType/title/metadata 就位', () => {
    const item = phMod.mapProductHuntPost({
      slug: 'cool-ai-tool',
      name: 'Cool AI Tool',
      tagline: 'do things',
      description: 'detailed',
      website: 'https://cool.ai/?utm_source=ph',
      url: 'https://www.producthunt.com/posts/cool-ai-tool',
      featuredAt: '2026-06-11T00:00:00Z',
      votesCount: 42,
    });
    expect(item.source).toBe('product_hunt');
    expect(item.rawType).toBe('product');
    expect(item.title).toBe('Cool AI Tool');
    expect(item.sourceItemId).toBe('cool-ai-tool');
    expect(item.content).toBe('detailed');
    expect(item.metadata?.product_hunt_slug).toBe('cool-ai-tool');
    // canonical_domain 去 www、去追踪参数后取 host。
    expect(item.metadata?.canonical_domain).toBe('cool.ai');
    expect(item.metadata?.votes_count).toBe(42);
  });

  it('产品名缺失 → title 兜底 slug（绝不留空）', () => {
    const item = phMod.mapProductHuntPost({
      slug: 'no-name-product',
      name: null,
      website: 'https://x.example.com',
    });
    expect(item.title).toBe('no-name-product');
    expect(item.title.length).toBeGreaterThan(0);
  });

  it('产品名与 slug 皆缺 → title 兜底 canonical_domain', () => {
    const item = phMod.mapProductHuntPost({
      slug: null,
      name: '   ',
      website: 'https://www.acme.io/launch',
    });
    expect(item.title).toBe('acme.io');
  });

  it('slug 缺失 → source_item_id 走 canonical_url（仍非空）', () => {
    const item = phMod.mapProductHuntPost({
      slug: null,
      name: 'Has URL',
      website: 'https://has-url.example/app',
    });
    expect(item.sourceItemId).toBe('https://has-url.example/app');
    expect(item.sourceItemId.length).toBeGreaterThan(0);
  });

  it('slug 与 URL 皆缺 → source_item_id 走内容哈希（64 hex，非空）', () => {
    const item = phMod.mapProductHuntPost({ name: 'No Keys', description: 'body' });
    expect(item.sourceItemId).toHaveLength(64);
  });
});

describe('extractCanonicalDomain / normalizeGithubRepo 归一化纯函数', () => {
  it('canonical_domain 去 www、小写', () => {
    expect(phMod.extractCanonicalDomain('https://WWW.Example.com/path')).toBe(
      'example.com',
    );
    expect(phMod.extractCanonicalDomain(null)).toBeNull();
  });
  it('github_repo 归一 owner/name（去 .git、小写）', () => {
    expect(collapseMod.normalizeGithubRepo('https://github.com/OpenAI/Whisper')).toBe(
      'openai/whisper',
    );
    expect(collapseMod.normalizeGithubRepo('https://github.com/a/b.git')).toBe('a/b');
    // 非 github URL → null（该键不参与合并）。
    expect(collapseMod.normalizeGithubRepo('https://gitlab.com/a/b')).toBeNull();
    // 路径不足两段 → null。
    expect(collapseMod.normalizeGithubRepo('https://github.com/onlyowner')).toBeNull();
  });
});

describe('extractProductMergeKeys 提取三键', () => {
  it('从 PH metadata 提 slug + canonical_domain；website 非 github → repo 为 null', () => {
    const keys = collapseMod.extractProductMergeKeys({
      id: 1n,
      title: 'T',
      url: 'https://prod.example.com',
      metadata: { product_hunt_slug: 'prod-x', website: 'https://prod.example.com' },
    });
    expect(keys.productHuntSlug).toBe('prod-x');
    expect(keys.canonicalDomain).toBe('prod.example.com');
    expect(keys.githubRepo).toBeNull();
  });
  it('website 是 github 仓库 → github_repo 归一 owner/name', () => {
    const keys = collapseMod.extractProductMergeKeys({
      id: 2n,
      title: 'OSS Tool',
      url: 'https://github.com/Acme/Tool',
      metadata: { product_hunt_slug: 'oss-tool', website: 'https://github.com/Acme/Tool' },
    });
    expect(keys.githubRepo).toBe('acme/tool');
    expect(keys.productHuntSlug).toBe('oss-tool');
  });
  it('全部键缺失 → 三键皆 null（NULL 键不参与约束）', () => {
    const keys = collapseMod.extractProductMergeKeys({
      id: 3n,
      title: 'Bare',
      url: null,
      metadata: null,
    });
    expect(keys.canonicalDomain).toBeNull();
    expect(keys.githubRepo).toBeNull();
    expect(keys.productHuntSlug).toBeNull();
  });
});

describe('collectProductHunt 限流与鉴权', () => {
  it('正常拉取：解析 edges → 统一条目', async () => {
    const items = await phMod.collectProductHunt({
      fetchGraphql: async () => ({
        body: bodyWith([
          { slug: 'a', name: 'A', website: 'https://a.com' },
          { slug: 'b', name: 'B', website: 'https://b.com' },
        ]),
        ...okHeaders,
      }),
    });
    expect(items.map((i) => i.sourceItemId)).toEqual(['a', 'b']);
  });

  it('401 鉴权错误：不重试，立即抛出（attempts=1）', async () => {
    let calls = 0;
    const logged: string[] = [];
    await expect(
      phMod.collectProductHunt({
        maxAttempts: 4,
        logError: (m) => logged.push(m),
        sleep: async () => {},
        fetchGraphql: async () => {
          calls += 1;
          throw new phMod.ProductHuntAuthError(401, 'revoked');
        },
      }),
    ).rejects.toBeInstanceOf(phMod.ProductHuntAuthError);
    expect(calls).toBe(1); // 鉴权错误绝不重试。
  });

  it('403 鉴权错误：同样不重试', async () => {
    let calls = 0;
    await expect(
      phMod.collectProductHunt({
        maxAttempts: 4,
        sleep: async () => {},
        logError: () => {},
        fetchGraphql: async () => {
          calls += 1;
          throw new phMod.ProductHuntAuthError(403, 'forbidden');
        },
      }),
    ).rejects.toBeInstanceOf(phMod.ProductHuntAuthError);
    expect(calls).toBe(1);
  });

  it('429 限流：退避重试有上限，超限放弃抛出', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      phMod.collectProductHunt({
        maxAttempts: 3,
        backoffBaseMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        logError: () => {},
        fetchGraphql: async () => {
          calls += 1;
          throw new phMod.ProductHuntRateLimitError('429');
        },
      }),
    ).rejects.toBeInstanceOf(phMod.ProductHuntRateLimitError);
    expect(calls).toBe(3); // 用满 maxAttempts。
    expect(sleeps).toEqual([10, 20]); // 指数退避，最后一次失败后不再 sleep。
  });

  it('429 中途恢复：退避后成功返回', async () => {
    let calls = 0;
    const items = await phMod.collectProductHunt({
      maxAttempts: 3,
      backoffBaseMs: 5,
      sleep: async () => {},
      logError: () => {},
      fetchGraphql: async () => {
        calls += 1;
        if (calls === 1) throw new phMod.ProductHuntRateLimitError('429');
        return { body: bodyWith([{ slug: 'rec', name: 'Rec' }]), ...okHeaders };
      },
    });
    expect(items.map((i) => i.sourceItemId)).toEqual(['rec']);
    expect(calls).toBe(2);
  });

  it('限流余量耗尽（remaining<=floor）：依 Reset 退避而非打满', async () => {
    const sleeps: number[] = [];
    await phMod.collectProductHunt({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logError: () => {},
      fetchGraphql: async () => ({
        body: bodyWith([{ slug: 's', name: 'S' }]),
        rateLimitRemaining: 0,
        rateLimitResetSeconds: 30,
      }),
    });
    // Reset=30s → 退避 30000ms。
    expect(sleeps).toContain(30000);
  });

  it('余量充足：不退避', async () => {
    const sleeps: number[] = [];
    await phMod.collectProductHunt({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logError: () => {},
      fetchGraphql: async () => ({
        body: bodyWith([{ slug: 's', name: 'S' }]),
        rateLimitRemaining: 1000,
        rateLimitResetSeconds: 30,
      }),
    });
    expect(sleeps).toEqual([]);
  });
});

describe('PH 注册进 registry（单源失败隔离）', () => {
  it('buildRegistry 含 product_hunt 条目', () => {
    const sources = indexMod
      .buildRegistry()
      .map((e) => e.source);
    expect(sources).toContain('product_hunt');
  });

  it('PH 抛错被 allSettled 隔离，其余源照常返回', async () => {
    const result = await indexMod.collectAllSources({
      logError: () => {},
      collectors: {
        rss: async () => [],
        hackerNews: async () => [],
        github: async () => [
          {
            source: 'github',
            sourceItemId: 'gh-1',
            url: 'https://github.com/a/b',
            title: 'a/b',
            content: null,
            publishedAt: null,
            rawType: 'repo',
          },
        ],
        arxiv: async () => [],
        productHunt: async () => {
          throw new Error('PH down');
        },
      },
    });
    // PH 失败被隔离。
    expect(result.perSource.product_hunt?.ok).toBe(false);
    // 其余源照常完成，github 条目仍在。
    expect(result.perSource.github?.ok).toBe(true);
    expect(result.items.map((i) => i.sourceItemId)).toEqual(['gh-1']);
  });
});
