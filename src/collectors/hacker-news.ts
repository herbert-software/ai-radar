/**
 * Hacker News Collector（任务 4.2，source-collectors）。
 *
 * 用 HN 官方 Firebase API：先取 topstories id 列表，再逐 id 取 item 详情。
 * source_item_id 直接用 HN item id（数值，稳定唯一），故无需走 canonical_url/内容哈希
 * fallback —— 但仍统一转为字符串并保证非空。
 *
 * 依赖注入：`fetchJson`（默认 global fetch）可注入桩，使单测无需真实网络。
 * 外部调用经 withRetry（有限重试 + 错误日志）；单条 item 抓取失败记日志后跳过，不拖垮整批。
 */
import { env } from '../config/env.js';
import {
  defaultLogError,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';

const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';

/** HN item 的最小视图（注入桩据此构造）。 */
export interface HackerNewsItem {
  id: number;
  type?: string;
  title?: string | null;
  url?: string | null;
  text?: string | null;
  time?: number | null;
  deleted?: boolean;
  dead?: boolean;
}

/** 抓取任意 JSON 的依赖契约（默认 global fetch；可注入 mock）。 */
export type FetchJsonFn = (url: string) => Promise<unknown>;

export interface HackerNewsCollectorOptions {
  /** 取 topstories 前 N 条，默认 30。 */
  limit?: number | undefined;
  /** 注入的 JSON 抓取实现，默认 global fetch。 */
  fetchJson?: FetchJsonFn | undefined;
  /** 每次外部调用最大重试次数。 */
  maxAttempts?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultFetchJson: FetchJsonFn = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HN API ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
};

function toDate(seconds: number | null | undefined): Date | null {
  if (seconds == null) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 把 HN item 映射为统一结构；source_item_id 用 item id（字符串化，非空）。 */
export function mapHackerNewsItem(item: HackerNewsItem): CollectedItem {
  return {
    source: 'hacker_news',
    sourceItemId: String(item.id),
    url: item.url ?? null,
    title: (item.title ?? '').trim(),
    content: item.text ?? null,
    publishedAt: toDate(item.time),
    rawType: 'post',
  };
}

/**
 * 采集 HN topstories 前 limit 条。
 * 逐条抓取，单条失败记日志后跳过（不拖垮整批）；id 列表抓取失败则整个源失败抛出，
 * 由编排层 allSettled 隔离。
 */
export async function collectHackerNews(
  options: HackerNewsCollectorOptions = {},
): Promise<CollectedItem[]> {
  const limit = options.limit ?? 30;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const logError = options.logError ?? defaultLogError;

  const retry = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
    withRetry(fn, {
      maxAttempts: options.maxAttempts,
      logError,
      sleep: options.sleep,
      label,
    });

  // 1. 取 topstories id 列表（失败抛出 → 整源失败）。
  const ids = (await retry(
    () => fetchJson(`${HN_API_BASE}/topstories.json`),
    'hn:topstories',
  )) as number[];

  const targetIds = Array.isArray(ids) ? ids.slice(0, limit) : [];

  // 2. 逐条抓取详情；单条失败记日志后跳过。
  const settled = await Promise.allSettled(
    targetIds.map((id) =>
      retry(() => fetchJson(`${HN_API_BASE}/item/${id}.json`), `hn:item:${id}`),
    ),
  );

  const items: CollectedItem[] = [];
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      const raw = result.value as HackerNewsItem | null;
      // 过滤 null（已删/不存在）、deleted、dead 的条目。
      if (!raw || raw.deleted || raw.dead || raw.id == null) return;
      items.push(mapHackerNewsItem(raw));
    } else {
      logError(`hn item 最终失败（已跳过）：${targetIds[idx]}`, result.reason);
    }
  });
  return items;
}
