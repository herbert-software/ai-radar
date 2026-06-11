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

describe('RSS source_item_id fallback 链', () => {
  it('有 guid → 用 guid', () => {
    const out = rssMod.mapRssItem({
      guid: 'guid-123',
      link: 'https://example.com/a?utm_source=x',
      title: 'T',
      content: 'C',
    });
    expect(out.sourceItemId).toBe('guid-123');
    expect(out.source).toBe('rss');
    expect(out.rawType).toBe('news');
  });

  it('无 guid → 回退即时生成的 canonical_url（去追踪参数）', () => {
    const out = rssMod.mapRssItem({
      link: 'https://example.com/a?utm_source=x&id=1',
      title: 'T',
      content: 'C',
    });
    expect(out.sourceItemId).toBe('https://example.com/a?id=1');
  });

  it('guid 与 canonical_url 皆缺 → 终端回退内容哈希，绝不为 NULL', () => {
    const out = rssMod.mapRssItem({ link: null, title: 'T', content: 'C' });
    expect(out.sourceItemId).toBe(typesMod.contentHash('T', 'C'));
    expect(out.sourceItemId.length).toBe(64);
  });

  it('空标题 + 空 URL + 空内容仍得非空 source_item_id', () => {
    const out = rssMod.mapRssItem({ title: '', link: null, content: null });
    expect(out.sourceItemId.length).toBe(64);
    expect(out.sourceItemId).not.toBe('');
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

describe('collectAllSources：单源失败不拖垮整批', () => {
  it('GitHub 抛错时 RSS/HN 照常返回，perSource 标记失败', async () => {
    const result = await mod.collectAllSources({
      logError: () => {},
      collectors: {
        rss: async () => [
          {
            source: 'rss',
            sourceItemId: 'r1',
            url: 'https://x/1',
            title: 'rss item',
            content: null,
            publishedAt: null,
            rawType: 'news',
          },
        ],
        hackerNews: async () => [
          {
            source: 'hacker_news',
            sourceItemId: 'h1',
            url: null,
            title: 'hn item',
            content: null,
            publishedAt: null,
            rawType: 'post',
          },
        ],
        github: async () => {
          throw new Error('GitHub 限流');
        },
      },
    });
    expect(result.items.map((i) => i.sourceItemId).sort()).toEqual(['h1', 'r1']);
    expect(result.perSource.rss.ok).toBe(true);
    expect(result.perSource.hacker_news.ok).toBe(true);
    expect(result.perSource.github.ok).toBe(false);
    expect(result.perSource.github.error).toBeInstanceOf(Error);
  });

  it('三源全挂 → items 为空（编排层据此告警）', async () => {
    const fail = async () => {
      throw new Error('down');
    };
    const result = await mod.collectAllSources({
      logError: () => {},
      collectors: { rss: fail, hackerNews: fail, github: fail },
    });
    expect(result.items).toHaveLength(0);
    expect(result.perSource.rss.ok).toBe(false);
    expect(result.perSource.hacker_news.ok).toBe(false);
    expect(result.perSource.github.ok).toBe(false);
  });
});
