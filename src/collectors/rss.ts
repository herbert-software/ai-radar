/**
 * RSS Collector（任务 4.1，source-collectors）。
 *
 * 职责：拉取 env.RSS_FEEDS 配置的每个 feed，解析为统一 `CollectedItem`。
 *
 * source_item_id fallback 链（关键不变量，绝不为 NULL）：
 *   guid → canonical_url（即时由 normalizeUrl 生成）→ sha256(title‖content)。
 * 之所以即时生成 canonical_url 作为 fallback，是为了用「规范化后稳定的 URL」而非
 * 含追踪参数的原始 link 当标识（spec 禁止用易变值当 source_item_id）。
 *
 * 依赖注入：`fetchFeed`（默认用 rss-parser 实网抓取）可注入桩，使单测无需真实网络。
 * 单源失败（某 feed 拉取/解析报错）经 withRetry 记日志后抛出，由编排层 allSettled 隔离，
 * 不拖垮其余 feed —— 本模块对「每个 feed」独立 allSettled，单 feed 失败不影响同源其余 feed。
 */
import RssParser from 'rss-parser';
import { env } from '../config/env.js';
import { normalizeUrl } from '../dedup/normalize.js';
import {
  contentHash,
  defaultLogError,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';

/** rss-parser 解析出的单条目最小视图（注入桩据此构造）。 */
export interface RssFeedItem {
  guid?: string | null;
  link?: string | null;
  title?: string | null;
  content?: string | null;
  contentSnippet?: string | null;
  isoDate?: string | null;
  pubDate?: string | null;
}

/** 解析后的 feed 视图。 */
export interface ParsedRssFeed {
  items: RssFeedItem[];
}

/** 抓取 + 解析单个 feed 的依赖契约（默认 rss-parser；可注入 mock）。 */
export type FetchFeedFn = (feedUrl: string) => Promise<ParsedRssFeed>;

export interface RssCollectorOptions {
  /** feed URL 清单，默认 env.RSS_FEEDS。 */
  feeds?: readonly string[] | undefined;
  /** 注入的抓取实现，默认 rss-parser 实网抓取。 */
  fetchFeed?: FetchFeedFn | undefined;
  /** 每个 feed 的最大重试次数。 */
  maxAttempts?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const sharedParser = new RssParser({ timeout: env.COLLECTOR_FETCH_TIMEOUT_MS });

const defaultFetchFeed: FetchFeedFn = async (feedUrl) => {
  const feed = await sharedParser.parseURL(feedUrl);
  return { items: (feed.items ?? []) as RssFeedItem[] };
};

function parseDate(item: RssFeedItem): Date | null {
  const raw = item.isoDate ?? item.pubDate ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 把一条 RSS item 映射为统一结构，落实 source_item_id fallback 链。
 * title 缺失时回退空串后再算——但空标题 + 空 URL + 空内容仍能由内容哈希得到非空 id，
 * 故 source_item_id 永不为 NULL。
 */
export function mapRssItem(item: RssFeedItem): CollectedItem {
  const title = (item.title ?? '').trim();
  const content = item.content ?? item.contentSnippet ?? null;
  const url = item.link ?? null;
  const canonicalUrl = normalizeUrl(url);

  // fallback 链：guid → canonical_url → sha256(title‖content)。
  const guid = item.guid?.trim();
  const sourceItemId =
    (guid && guid.length > 0 ? guid : null) ??
    canonicalUrl ??
    contentHash(title, content);

  return {
    source: 'rss',
    sourceItemId,
    url,
    title,
    content,
    publishedAt: parseDate(item),
    rawType: 'news',
  };
}

/**
 * 采集所有配置的 RSS feed，返回统一结构条目（去聚合，不入库）。
 * 每个 feed 独立 withRetry + allSettled：单个 feed 失败记日志后不拖垮其余 feed。
 */
export async function collectRss(
  options: RssCollectorOptions = {},
): Promise<CollectedItem[]> {
  const feeds = options.feeds ?? env.RSS_FEEDS;
  const fetchFeed = options.fetchFeed ?? defaultFetchFeed;
  const logError = options.logError ?? defaultLogError;

  if (feeds.length === 0) return [];

  const settled = await Promise.allSettled(
    feeds.map((feedUrl) =>
      withRetry(() => fetchFeed(feedUrl), {
        maxAttempts: options.maxAttempts,
        logError,
        sleep: options.sleep,
        label: `rss:${feedUrl}`,
      }),
    ),
  );

  const items: CollectedItem[] = [];
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      for (const raw of result.value.items) {
        items.push(mapRssItem(raw));
      }
    } else {
      logError(`rss feed 最终失败（已跳过）：${feeds[idx]}`, result.reason);
    }
  });
  return items;
}
