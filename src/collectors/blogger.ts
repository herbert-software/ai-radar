/**
 * Blogger Collector（add-ai-blogger-experience-mining，任务 2.1–2.4，source-collectors）。
 *
 * 职责：拉取 env.BLOGGER_FEEDS 配置的每个策划 AI 博主 feed（博客 / Substack / YouTube 频道 RSS），
 * 解析为统一 `CollectedItem`，**用独立映射 `mapBloggerItem` 产出两硬字段**
 * `source='blogger'` / `raw_type='experience'` + `collapsed=true`。
 *
 * **隔离命门（不变量，design D3 / spec）**：`raw_items.source`/`raw_type` 由 collector 返回的
 * `item.source`/`item.rawType` 直写（store.ts，DB 裸 varchar 不挡）。既有 `mapRssItem` 把
 * `source:'rss'`/`raw_type:'news'` 硬钉为内部常量；blogger **绝不得复用** `mapRssItem`（否则静默
 * 写入 source='rss'/raw_type='news' → 两硬字段隔离失效、经验帖被塌进 ai_news_events），故走本独立
 * 映射。registry 注册本 collector 的 `source` 字段必须与 `mapBloggerItem` 产出的 `item.source` 一致。
 *
 * source_item_id fallback 链（关键不变量，绝不为 NULL）：复用 RSS 的范式——
 *   命名空间化 guid `sha256(feed_url ‖ NUL ‖ guid)` → canonical_url → sha256(title‖content)。
 * YouTube Atom feed 由 `rss-parser` 原生解析（无需补 Atom 分支）；YouTube entry 常无传统 guid，
 * 经 fallback 链取 canonical_url（watch URL 稳定，源内幂等成立）。
 *
 * **YouTube 字幕增强（design D3 / spec）**：`mapBloggerItem` 是同步纯函数无网络；取字幕须在采集阶段
 * 对 host=youtube.com 的条目**逐条 await** 拉 transcript 作 `content`。字幕拉取抽成可注入的「逐条
 * content 增强 hook」（默认实现 = youtube-transcript 库；**测试注入桩、不触网**），带重试 + 错误日志，
 * 单条失败被隔离 → 退化为仅标题 + 简介落库，**绝不 ASR、绝不中止整批**（与单源失败隔离对称）。
 *
 * 依赖注入：`fetchFeed`（默认 rss-parser）、`fetchTranscript`（默认 youtube-transcript）可注入桩，
 * 使单测无需真实网络。单 feed 失败经 withRetry 记日志后由 allSettled 隔离、不拖垮其余 feed。
 */
import RssParser from 'rss-parser';
import { env, type RssFeedConfig } from '../config/env.js';
import { normalizeUrl, sha256Hex } from '../dedup/normalize.js';
import {
  contentHash,
  defaultLogError,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';
import type { ParsedRssFeed, RssFeedItem } from './rss.js';

/** 抓取 + 解析单个 feed 的依赖契约（默认 rss-parser；可注入 mock）。 */
export type FetchFeedFn = (feedUrl: string) => Promise<ParsedRssFeed>;

/**
 * 拉取单个 YouTube 视频字幕的依赖契约（默认 youtube-transcript；可注入桩使单测不触网）。
 * 入参为视频 watch URL（或视频 id），返回拼接后的字幕全文；无字幕/失败由调用方按隔离语义处理。
 */
export type FetchTranscriptFn = (videoUrl: string) => Promise<string>;

export interface BloggerCollectorOptions {
  /** 带 vendor 标记的 feed 配置清单，默认 env.BLOGGER_FEEDS（已解析为 {url, vendor}[]）。 */
  feeds?: readonly RssFeedConfig[] | undefined;
  /** 注入的 feed 抓取实现，默认 rss-parser 实网抓取。 */
  fetchFeed?: FetchFeedFn | undefined;
  /** 注入的字幕抓取实现，默认 youtube-transcript 实网抓取。 */
  fetchTranscript?: FetchTranscriptFn | undefined;
  /** 每个 feed / 每条字幕的最大重试次数。 */
  maxAttempts?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** 单次字幕抓取的超时毫秒数，默认 env.COLLECTOR_FETCH_TIMEOUT_MS（测试可设小值快超时）。 */
  transcriptTimeoutMs?: number | undefined;
}

const sharedParser = new RssParser({ timeout: env.COLLECTOR_FETCH_TIMEOUT_MS });

/**
 * 给 promise 套超时上界：超时则 reject，使调用方的 withRetry 能捕获并最终降级。
 * youtube-transcript 不接受 AbortSignal/无内建超时，底层 HTTP 挂起（永不 resolve/reject）会卡死
 * 整个 collectBlogger（进而卡死日报采集链）——故每次字幕抓取必须有超时。
 * ponytail: lib 无 AbortSignal，超时后底层 fetch 孤立运行（不阻塞，race 已 resolve）；要真取消需 lib 支持 AbortSignal。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const defaultFetchFeed: FetchFeedFn = async (feedUrl) => {
  const feed = await sharedParser.parseURL(feedUrl);
  return { items: (feed.items ?? []) as RssFeedItem[] };
};

/**
 * 默认字幕实现：经 youtube-transcript 拉取字幕段并拼接为全文。
 * 库返回字幕段数组（{ text, ... }[]）；无字幕/被禁用时库自身抛错，由调用方 withRetry + 隔离处理。
 * 动态 import：避免该库在不采 YouTube 的部署里成为启动期硬依赖（与本采集器其余逻辑解耦）。
 */
const defaultFetchTranscript: FetchTranscriptFn = async (videoUrl) => {
  const { YoutubeTranscript } = await import('youtube-transcript');
  const segments = await YoutubeTranscript.fetchTranscript(videoUrl);
  return segments.map((s) => s.text).join(' ').trim();
};

function parseDate(item: RssFeedItem): Date | null {
  const raw = item.isoDate ?? item.pubDate ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 判定一个 URL 是否指向 YouTube（host 为 youtube.com 或其子域，如 www.youtube.com）。
 * 用归一化 host 判（design D3：「是否 youtube 靠 URL host 判」）；非法/相对 URL → false（不抛）。
 */
export function isYouTubeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return host === 'youtube.com' || host.endsWith('.youtube.com');
}

/**
 * 把一条 blogger feed item 映射为统一结构（**独立于 mapRssItem**，产出经验类两硬字段）。
 *
 * 与 mapRssItem 的唯一实质差异是三硬字段：`source='blogger'` / `rawType='experience'` /
 * `collapsed=true`（沉淀，使经验行不被新闻/告警事件塌缩的 collapsed=false 过滤选入）。
 * source_item_id fallback 链与 vendor provenance 范式同 RSS（命名空间化 guid → canonical_url →
 * 内容哈希）。`content` 由调用方（collectBlogger）在 YouTube 字幕增强后注入；本纯函数取 feed 自带
 * content/contentSnippet 作默认正文（无字幕 / 非 YouTube 时即为终态）。
 *
 * @param item     rss-parser 解析出的单条目（YouTube Atom 亦经 rss-parser 原生归一为同形）。
 * @param feedUrl  该条目所属 feed 的 URL（用于 guid 命名空间化 + 落 metadata.feed_url）。
 * @param vendor   该 feed 的厂商/博主标识（未配则 null，落 metadata.vendor）。
 * @param contentOverride 可选正文覆盖（YouTube 字幕全文）；传入则取代 feed 自带 content。
 */
export function mapBloggerItem(
  item: RssFeedItem,
  feedUrl: string,
  vendor: string | null,
  contentOverride?: string | null,
): CollectedItem {
  const title = (item.title ?? '').trim();
  const content =
    contentOverride !== undefined && contentOverride !== null
      ? contentOverride
      : item.content ?? item.contentSnippet ?? null;
  const url = item.link ?? null;
  const canonicalUrl = normalizeUrl(url);

  // fallback 链：命名空间化 guid → canonical_url → sha256(title‖content)。
  // 分隔符为 NUL 字节（feed_url ‖ '\0' ‖ guid），与 RSS 同口径，杜绝拼接歧义。
  const guid = item.guid?.trim();
  const namespacedGuid =
    guid && guid.length > 0 ? sha256Hex(`${feedUrl}\0${guid}`) : null;
  const sourceItemId =
    namespacedGuid ?? canonicalUrl ?? contentHash(title, content);

  return {
    // 两硬字段确定性标记（隔离命门）：绝不是 'rss'/'news'。
    source: 'blogger',
    sourceItemId,
    url,
    title,
    content,
    publishedAt: parseDate(item),
    rawType: 'experience',
    // 入库即沉淀：经验行不被新闻/告警塌缩的 collapsed=false 过滤选入（design D4 第一道隔离）。
    collapsed: true,
    metadata: { vendor, feed_url: feedUrl },
  };
}

/**
 * 对一条 YouTube 视频条目逐条尝试拉字幕作正文：成功 → 字幕全文；失败/无字幕 → null（退化为标题+简介）。
 *
 * 失败隔离（design D3 / spec）：带 withRetry，重试耗尽后**不向上抛**——记日志并返回 null，使该条退化为
 * 仅标题+简介落库，绝不中止整批采集（与单源失败隔离对称）。空字幕（库返回空串）同样退化。
 */
async function tryFetchTranscript(
  videoUrl: string,
  fetchTranscript: FetchTranscriptFn,
  logError: LogError,
  maxAttempts: number | undefined,
  sleep: ((ms: number) => Promise<void>) | undefined,
  timeoutMs: number,
): Promise<string | null> {
  try {
    // 每次尝试套超时：底层挂起 → reject → withRetry 捕获重试 → 耗尽 return null 降级（不卡死整批）。
    const text = await withRetry(
      () => withTimeout(fetchTranscript(videoUrl), timeoutMs),
      {
        maxAttempts,
        logError,
        sleep,
        label: `blogger:transcript:${videoUrl}`,
      },
    );
    const trimmed = text?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    // 重试耗尽：退化为仅标题+简介（不 ASR、不中止整批）。
    logError(
      `YouTube 字幕拉取最终失败（已隔离，退化为标题+简介）：${videoUrl}`,
      error,
    );
    return null;
  }
}

/**
 * 采集所有配置的 blogger feed，返回统一结构条目（不入库）。
 *
 * 每个 feed 独立 withRetry + allSettled：单个 feed 失败记日志后不拖垮其余 feed。
 * 对 host=youtube.com 的条目逐条 await 拉字幕作正文（失败隔离退化），其余条目直接取 feed 自带正文。
 */
export async function collectBlogger(
  options: BloggerCollectorOptions = {},
): Promise<CollectedItem[]> {
  const feeds = options.feeds ?? env.BLOGGER_FEEDS;
  const fetchFeed = options.fetchFeed ?? defaultFetchFeed;
  const fetchTranscript = options.fetchTranscript ?? defaultFetchTranscript;
  const logError = options.logError ?? defaultLogError;
  const transcriptTimeoutMs =
    options.transcriptTimeoutMs ?? env.COLLECTOR_FETCH_TIMEOUT_MS;

  if (feeds.length === 0) return [];

  const settled = await Promise.allSettled(
    feeds.map((feed) =>
      withRetry(() => fetchFeed(feed.url), {
        maxAttempts: options.maxAttempts,
        logError,
        sleep: options.sleep,
        label: `blogger:${feed.url}`,
      }),
    ),
  );

  const items: CollectedItem[] = [];
  for (let idx = 0; idx < settled.length; idx++) {
    const result = settled[idx]!;
    const feed = feeds[idx]!;
    if (result.status !== 'fulfilled') {
      logError(`blogger feed 最终失败（已跳过）：${feed.url}`, result.reason);
      continue;
    }
    for (const raw of result.value.items) {
      // YouTube 条目逐条增强字幕作正文（失败隔离退化为 null → 仅标题+简介）；非 YouTube 直接映射。
      let contentOverride: string | null | undefined;
      if (isYouTubeUrl(raw.link)) {
        contentOverride = await tryFetchTranscript(
          raw.link!,
          fetchTranscript,
          logError,
          options.maxAttempts,
          options.sleep,
          transcriptTimeoutMs,
        );
      }
      items.push(mapBloggerItem(raw, feed.url, feed.vendor, contentOverride));
    }
  }
  return items;
}
