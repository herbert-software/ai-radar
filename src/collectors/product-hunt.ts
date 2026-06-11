/**
 * Product Hunt Collector（任务 7.2，source-collectors / design D1）。
 *
 * 用只读 Developer Token 调 Product Hunt GraphQL（v2）拉当日上榜产品，解析为统一
 * `CollectedItem`（`source='product_hunt'`、`rawType='product'`），**先落 `raw_items`**——
 * 与其它采集源一致进入统一原始证据层，**禁止绕过 raw_items 直写 ai_products**
 * （产品塌缩进 ai_products 是下游确定性步骤，见 product-collapse.ts）。
 *
 * 不变量（spec product-discovery / design D1）：
 * - PH 产品名写入 `title`（满足 raw_items.title NOT NULL），并作下游 ai_products.name 的来源；
 *   产品名罕见缺失时以确定性兜底值（slug → canonical_domain）填充 title，**绝不留空**致入库失败。
 * - PH 原始 payload 入 `metadata`（slug / website / votes 等），供下游塌缩提归一化键。
 * - source_item_id 用 PH 原生 slug（最稳定）；slug 缺失走 canonical_url → 内容哈希（types.contentHash）。
 *
 * 限流与退避（spec：GraphQL 约 6250 复杂度点/15min）：
 * - 读响应头 `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset`，余量耗尽（降至 0 / 接近 0）时
 *   依 Reset 退避到下个重置窗口再继续，**禁止无视限流头持续打满**。
 * - HTTP 429 → 指数退避重试且有上限，超限本轮放弃记 error，由编排层 allSettled 隔离。
 * - 鉴权错误（HTTP 401/403，token 被撤销/过期）**不进入退避重试**（重试不可恢复错误只浪费预算），
 *   直接按单源失败抛出、由 allSettled 隔离。
 *
 * 依赖注入：`fetchGraphql`（默认 global fetch + Bearer token）、`sleep`、`now` 可注入，
 * 使单测无需真实网络/token（仿 github.ts / arxiv.ts 注入模式）。
 */
import { env } from '../config/env.js';
import { normalizeUrl } from '../dedup/normalize.js';
import { startOfDayInTimeZone } from '../push/push-date.js';
import {
  contentHash,
  defaultLogError,
  type CollectedItem,
  type LogError,
} from './types.js';

/** Product Hunt GraphQL 端点（v2）。 */
const PRODUCT_HUNT_GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';

/** 鉴权类错误（HTTP 401/403）：不进入退避重试，直接隔离。 */
export class ProductHuntAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProductHuntAuthError';
  }
}

/** 限流错误（HTTP 429）：进入退避重试（有上限）。 */
export class ProductHuntRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductHuntRateLimitError';
  }
}

/** GraphQL 返回的单个 post 的最小视图（注入桩据此构造）。 */
export interface ProductHuntPost {
  /** PH 原生 slug（最稳定的源内标识，作 source_item_id 与 product_hunt_slug）。 */
  slug?: string | null;
  /** 产品名（写入 title 与下游 ai_products.name）。 */
  name?: string | null;
  /** 一句话简介。 */
  tagline?: string | null;
  /** 详细描述。 */
  description?: string | null;
  /** 产品官网 URL（提 canonical_domain 的来源）。 */
  website?: string | null;
  /** PH 帖子页 URL。 */
  url?: string | null;
  /** 上榜/发布时间（ISO）。 */
  featuredAt?: string | null;
  createdAt?: string | null;
  votesCount?: number | null;
}

/**
 * fetchGraphql 的返回：body（已解析 JSON）+ 限流头。
 * 把「网络/解析」与「限流头读取」收口到注入契约，使节流逻辑可在单测注入桩里驱动。
 */
export interface ProductHuntFetchResult {
  /** GraphQL 响应 body（已 JSON.parse）。 */
  body: unknown;
  /** `X-Rate-Limit-Remaining` 头（数字，缺失/不可解析为 null）。 */
  rateLimitRemaining: number | null;
  /** `X-Rate-Limit-Reset` 头（到下个重置窗口的秒数，缺失/不可解析为 null）。 */
  rateLimitResetSeconds: number | null;
}

/** 调 PH GraphQL 的依赖契约（默认 global fetch + Bearer token；可注入 mock）。 */
export type FetchGraphqlFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<ProductHuntFetchResult>;

export interface ProductHuntCollectorOptions {
  /** Developer Token，默认 env.PRODUCT_HUNT_TOKEN。 */
  token?: string | undefined;
  /** 取前 N 条，默认 20（GraphQL first 参数）。 */
  limit?: number | undefined;
  /** 注入的 GraphQL 抓取实现，默认 global fetch。 */
  fetchGraphql?: FetchGraphqlFn | undefined;
  /** 429 退避重试上限（含首次），默认 4。超限本轮放弃。 */
  maxAttempts?: number | undefined;
  /** 429 退避基础毫秒（指数退避），默认 1000。 */
  backoffBaseMs?: number | undefined;
  /**
   * 「余量接近耗尽」的阈值：remaining <= 此值即视为耗尽、依 Reset 退避，默认 0。
   * 取 0 表示仅在严格耗尽时退避；可调大以更保守。
   */
  rateLimitFloor?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function parseHeaderNumber(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** 默认 GraphQL 抓取实现：global fetch + Bearer token，读限流头，按状态码分类错误。 */
const defaultFetchGraphql =
  (token: string): FetchGraphqlFn =>
  async (query, variables) => {
    const res = await fetch(PRODUCT_HUNT_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'ai-radar',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
    });

    if (res.status === 429) {
      throw new ProductHuntRateLimitError(`Product Hunt GraphQL 429 限流`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProductHuntAuthError(
        res.status,
        `Product Hunt GraphQL ${res.status} 鉴权失败（token 被撤销/过期？）`,
      );
    }
    if (!res.ok) {
      throw new Error(`Product Hunt GraphQL ${res.status} ${res.statusText}`);
    }

    return {
      body: await res.json(),
      rateLimitRemaining: parseHeaderNumber(res.headers.get('X-Rate-Limit-Remaining')),
      rateLimitResetSeconds: parseHeaderNumber(res.headers.get('X-Rate-Limit-Reset')),
    };
  };

function toDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 取「今日 0 点（**Asia/Shanghai**，env.PUSH_TIMEZONE）」的 ISO，作 postedAfter 过滤当日上榜。
 *
 * 必须与 push_date / 产品推送窗口同源时区（Asia/Shanghai）——用 UTC 午夜会在时区边界附近让 PH
 * 的「今天」与上海「今天」错位（Bugbot #3）。复用 push-date 的 startOfDayInTimeZone（daysBack=0）。
 */
function startOfTodayIso(): string {
  return startOfDayInTimeZone(new Date(), 0).toISOString();
}

/**
 * 把一条 PH post 映射为统一结构。
 *
 * - title：产品名；缺失兜底 slug → canonical_domain（绝不留空，满足 raw_items.title NOT NULL）。
 * - source_item_id：slug（最稳定）→ canonical_url → 内容哈希（绝不为空，源内幂等）。
 * - metadata：透传 slug / website / 帖子 URL / votes 等原始 payload，供下游塌缩提归一化键。
 */
export function mapProductHuntPost(post: ProductHuntPost): CollectedItem {
  const slug = post.slug?.trim() || null;
  const website = post.website?.trim() || null;
  const canonicalUrl = normalizeUrl(website);
  const canonicalDomain = extractCanonicalDomain(canonicalUrl);
  const phUrl = post.url?.trim() || null;
  const name = post.name?.trim() || null;

  // title 兜底链：产品名 → slug → canonical_domain（任一非空）→ 终极占位（绝不留空）。
  const title = name ?? slug ?? canonicalDomain ?? '(unnamed product)';

  const content = post.description?.trim() || post.tagline?.trim() || null;

  // source_item_id：slug 优先（PH 原生稳定）→ 规范化 URL → 内容哈希；绝不为空。
  const sourceItemId =
    slug ?? canonicalUrl ?? normalizeUrl(phUrl) ?? contentHash(title, content);

  const metadata: Record<string, unknown> = {
    product_hunt_slug: slug,
    website,
    canonical_domain: canonicalDomain,
    product_hunt_url: phUrl,
    tagline: post.tagline?.trim() || null,
    votes_count: post.votesCount ?? null,
  };

  return {
    source: 'product_hunt',
    sourceItemId,
    url: website ?? phUrl,
    title,
    content,
    publishedAt: toDate(post.featuredAt ?? post.createdAt),
    rawType: 'product',
    metadata,
  };
}

/**
 * 从 canonical_url 提取 canonical_domain：host 小写、去 `www.` 前缀。
 * normalizeUrl 已做 host 小写化与追踪参数清理；此处只取 host 并剥 www，口径与下游塌缩一致。
 * 输入为 null（无可用 URL）→ 返回 null（该键不参与合并）。
 */
export function extractCanonicalDomain(canonicalUrl: string | null): string | null {
  if (!canonicalUrl) return null;
  let host: string;
  try {
    host = new URL(canonicalUrl).host.toLowerCase();
  } catch {
    return null;
  }
  if (host.length === 0) return null;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** 当日上榜产品的 GraphQL 查询（按票数倒序，postedAfter=今日）。 */
const POSTS_QUERY = `
query DailyPosts($first: Int!, $postedAfter: DateTime) {
  posts(first: $first, order: VOTES, postedAfter: $postedAfter) {
    edges {
      node {
        slug
        name
        tagline
        description
        website
        url
        featuredAt
        createdAt
        votesCount
      }
    }
  }
}`;

/** 从 GraphQL body 安全提取 posts 节点数组（结构异常时返回空数组，不抛）。 */
function extractPosts(body: unknown): ProductHuntPost[] {
  const edges = (body as { data?: { posts?: { edges?: unknown } } } | null)?.data?.posts
    ?.edges;
  if (!Array.isArray(edges)) return [];
  const posts: ProductHuntPost[] = [];
  for (const edge of edges) {
    const node = (edge as { node?: ProductHuntPost } | null)?.node;
    if (node && typeof node === 'object') posts.push(node);
  }
  return posts;
}

/**
 * 采集 Product Hunt 当日上榜产品 → 统一结构（先落 raw_items 由编排层入库）。
 *
 * 单次请求：
 * - 429（ProductHuntRateLimitError）→ 指数退避重试，**有上限**（maxAttempts）；超限抛出本源失败。
 * - 401/403（ProductHuntAuthError）→ **不重试**，记 error 立即抛出（重试不可恢复鉴权错误只浪费预算）。
 * - 其余错误（超时等）→ 也走有限退避重试。
 * - 成功后读限流头：余量 <= floor 即依 Reset 退避到下个窗口（本轮已拿到数据，退避供下次调用前生效）。
 *
 * 整源调用失败抛出，由编排层 `Promise.allSettled` 隔离、不拖垮整批。
 */
export async function collectProductHunt(
  options: ProductHuntCollectorOptions = {},
): Promise<CollectedItem[]> {
  const token = options.token ?? env.PRODUCT_HUNT_TOKEN;
  const limit = options.limit ?? 20;
  const fetchGraphql = options.fetchGraphql ?? defaultFetchGraphql(token);
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffBaseMs = options.backoffBaseMs ?? 1000;
  const rateLimitFloor = options.rateLimitFloor ?? 0;
  const logError = options.logError ?? defaultLogError;
  const sleep = options.sleep ?? realSleep;

  const variables = { first: limit, postedAfter: startOfTodayIso() };

  let lastError: unknown;
  let result: ProductHuntFetchResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await fetchGraphql(POSTS_QUERY, variables);
      break;
    } catch (error) {
      lastError = error;
      // 鉴权错误：不进入退避重试，立即抛出（由编排层 allSettled 隔离）。
      if (error instanceof ProductHuntAuthError) {
        logError(`Product Hunt 鉴权失败（不重试，直接隔离）：${error.status}`, error);
        throw error;
      }
      const isRate = error instanceof ProductHuntRateLimitError;
      logError(
        `product_hunt:graphql：第 ${attempt}/${maxAttempts} 次${isRate ? '（429 限流）' : ''}失败`,
        error,
      );
      // 达上限：放弃本轮、抛出（不无界 pending 拖长 job）。
      if (attempt >= maxAttempts) break;
      if (backoffBaseMs > 0) await sleep(backoffBaseMs * 2 ** (attempt - 1));
    }
  }

  if (result === null) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`product_hunt:graphql 在 ${maxAttempts} 次尝试后仍失败：${String(lastError)}`);
  }

  // 读限流头：余量耗尽（<= floor）则依 Reset 退避到下个重置窗口，禁止无视限流头持续打满。
  // 本轮已拿到数据，退避使「下次调用前」尊重重置窗口（单实例采集假设下生效，design D3 同口径）。
  if (
    result.rateLimitRemaining !== null &&
    result.rateLimitRemaining <= rateLimitFloor &&
    result.rateLimitResetSeconds !== null &&
    result.rateLimitResetSeconds > 0
  ) {
    logError(
      `Product Hunt 限流余量耗尽（remaining=${result.rateLimitRemaining}），` +
        `依 Reset 退避 ${result.rateLimitResetSeconds}s 到下个重置窗口`,
      { remaining: result.rateLimitRemaining, reset: result.rateLimitResetSeconds },
    );
    await sleep(result.rateLimitResetSeconds * 1000);
  }

  return extractPosts(result.body).map(mapProductHuntPost);
}
