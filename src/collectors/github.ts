/**
 * GitHub Collector（任务 4.3，source-collectors）。
 *
 * 用 GitHub Search API 取近期高 star 的仓库（近似 trending）。带 env.GITHUB_TOKEN 时
 * 加 Authorization 头提额（匿名 60 req/h → 认证 5000 req/h，缓解限流，design 风险条）。
 *
 * source_item_id 用 repo 稳定 id：优先数值 `id`（永不随改名变化），回退 `full_name`。
 * 两者都是 GitHub 侧稳定标识，故无需 canonical_url/内容哈希 fallback —— 但统一字符串化保证非空。
 *
 * 依赖注入：`fetchJson`（默认 global fetch + 鉴权头）可注入桩，使单测无需真实网络/token。
 * 外部调用经 withRetry（有限重试 + 错误日志）；整源失败抛出由编排层 allSettled 隔离。
 */
import { env } from '../config/env.js';
import {
  contentHash,
  defaultLogError,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';

/** GitHub 仓库的最小视图（注入桩据此构造）。 */
export interface GitHubRepo {
  id?: number | null;
  full_name?: string | null;
  name?: string | null;
  html_url?: string | null;
  description?: string | null;
  pushed_at?: string | null;
  created_at?: string | null;
  stargazers_count?: number | null;
}

/** Search API 响应的最小视图。 */
export interface GitHubSearchResponse {
  items?: GitHubRepo[];
}

/** 抓取 JSON（带可选鉴权头）的依赖契约（默认 global fetch；可注入 mock）。 */
export type FetchJsonFn = (
  url: string,
  headers: Record<string, string>,
) => Promise<unknown>;

export interface GitHubCollectorOptions {
  /**
   * Search 查询串，默认取近 7 天创建、按 star 倒序。
   * 可注入以采特定 topic/口径（design 待解决问题：trending/topic/starred 留 config）。
   */
  query?: string | undefined;
  /** 取前 N 条，默认 30（GitHub Search per_page 上限 100）。 */
  limit?: number | undefined;
  /** GitHub token，默认 env.GITHUB_TOKEN（空则匿名）。 */
  token?: string | undefined;
  /** 注入的 JSON 抓取实现，默认 global fetch。 */
  fetchJson?: FetchJsonFn | undefined;
  /** 最大重试次数。 */
  maxAttempts?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultFetchJson: FetchJsonFn = async (url, headers) => {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
};

function toDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function defaultQuery(): string {
  // 近 7 天创建的仓库，按 star 倒序——近似 trending，且对 AI 相关性留给下游 Value Judge 判定。
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `created:>${since}`;
}

/**
 * 把 GitHub repo 映射为统一结构。
 * source_item_id：数值 id 优先（稳定不随改名变），回退 full_name；皆缺则极端兜底为 name。
 * 这三者都是 GitHub 侧稳定标识，绝不为空（id/full_name 在正常响应中必有其一）。
 */
export function mapGitHubRepo(repo: GitHubRepo): CollectedItem {
  const stableId =
    repo.id != null
      ? String(repo.id)
      : (repo.full_name && repo.full_name.length > 0
          ? repo.full_name
          : repo.name && repo.name.length > 0
            ? repo.name
            : null);

  const title = (repo.full_name ?? repo.name ?? '').trim();
  const content = repo.description ?? null;

  // 极端兜底：响应异常到连 id/full_name/name 都没有时，用 html_url 或内容哈希，绝不为空且互不共用。
  const sourceItemId = stableId ?? repo.html_url ?? contentHash(title, content);

  return {
    source: 'github',
    sourceItemId,
    url: repo.html_url ?? null,
    title,
    content,
    publishedAt: toDate(repo.pushed_at ?? repo.created_at),
    rawType: 'repo',
    metadata:
      repo.stargazers_count != null
        ? { stargazers_count: repo.stargazers_count }
        : undefined,
  };
}

/** 采集 GitHub 近期高 star 仓库。整源调用失败抛出由编排层隔离。 */
export async function collectGitHub(
  options: GitHubCollectorOptions = {},
): Promise<CollectedItem[]> {
  const query = options.query ?? defaultQuery();
  const limit = options.limit ?? 30;
  const token = options.token ?? env.GITHUB_TOKEN;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const logError = options.logError ?? defaultLogError;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ai-radar',
  };
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }

  const perPage = Math.min(limit, 100);
  const url =
    `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(query)}` +
    `&sort=stars&order=desc&per_page=${perPage}`;

  const response = (await withRetry(() => fetchJson(url, headers), {
    maxAttempts: options.maxAttempts,
    logError,
    sleep: options.sleep,
    label: 'github:search',
  })) as GitHubSearchResponse;

  const repos = Array.isArray(response.items) ? response.items.slice(0, limit) : [];
  return repos.map(mapGitHubRepo);
}
