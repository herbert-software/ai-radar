/**
 * 产品归一键提取（叶子纯函数模块，design D7）。
 *
 * 承载产品塌缩与 Show HN 采集器共用的「产品三归一键提取」纯逻辑：
 *   - `canonical_domain`：由产品 URL 经 URL 规范化提取 host（去 www）。
 *   - `github_repo`：github.com 仓库 URL 归一为 `owner/name`（≥2 段路径才有效）。
 *   - `product_hunt_slug`：PH 原生 slug（Show HN 无此键、空、不参与合并，合规）。
 *
 * **本模块刻意是「叶子纯模块」（design D7 层次倒置修复）**：传递闭包**零 `../db`、零 `../config/env`**。
 * 仅 import `normalizeUrl`（dedup/normalize，本身只依赖 crypto / emoji-regex / opencc）。
 * 故采集器 import 它**既不实例化 PG 连接池**（product-collapse.ts 顶层 `import { db }` 会开池）、
 * **也不触发 env.ts 启动校验 side-effect**——纯 HTTP 采集器（rss / hacker-news / github / arxiv /
 * product-hunt / show-hn）刻意零 `../db` 依赖，借此模块复用提键逻辑而不污染单测 / 无库环境。
 *
 * 入参收窄为最小读字段 `ProductKeyInput { url?, metadata? }`：`extractProductMergeKeys` 只读它真用到
 * 的 `url` / `metadata`，**不要求 `id` / `title`**（消除采集器伪造 `id:0n` 的异味）。product-collapse 的
 * `ProductRawItem` 结构兼容 `ProductKeyInput`，直接传入即可。
 *
 * **F1 修复（design D5 / spec product-discovery）**：`canonical_domain === 'github.com'` 时**无条件**置 null
 * （不 gate 在 github_repo 非空上）。github.com 非有意义的产品域——指向具体 repo 的产品用 `github_repo`
 * 作精确键；指向 `github.com/owner` org/profile 页的「产品」无具体 repo（github_repo 也为 null）→ 三键全空、
 * 由采集器跳过。无条件抑制 + 采集器三键全空跳过彻底闭合（防 github 托管产品共享 github.com 域静默误并）。
 */
import { normalizeUrl } from '../dedup/normalize.js';

/** 三个硬合并归一化键（任一可为 null，null 键不参与约束）。 */
export interface ProductMergeKeys {
  canonicalDomain: string | null;
  githubRepo: string | null;
  productHuntSlug: string | null;
}

/**
 * 提键的最小入参（只读 url / metadata）。
 * 采集器以 `{ url, metadata }` 调用作跳过判据，product-collapse 的 `ProductRawItem` 亦结构兼容。
 */
export interface ProductKeyInput {
  /** 原始 url（产品官网，提 canonical_domain / github_repo 的来源）。 */
  url?: string | null | undefined;
  /** raw_items.metadata（含 product_hunt_slug / website / canonical_domain / github_repo 等）。 */
  metadata?: Record<string, unknown> | null | undefined;
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 把 github.com 仓库 URL 归一为 `owner/name`（小写 host 判定，去 .git 后缀与尾斜杠）。
 * 非 github.com URL / 路径不足两段 → null（该键不参与合并）。
 */
export function normalizeGithubRepo(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;
  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0]!.toLowerCase();
  const name = segments[1]!.replace(/\.git$/i, '').toLowerCase();
  if (owner.length === 0 || name.length === 0) return null;
  return `${owner}/${name}`;
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

/**
 * 从 product 入参提取三个非空归一化键（确定性纯函数）。
 * - product_hunt_slug：metadata.product_hunt_slug（PH 原生 slug）。
 * - canonical_domain：由 metadata.website（或 url）经 normalizeUrl + extractCanonicalDomain 提取。
 * - github_repo：若 website/url 是 github.com 仓库 URL，则归一 owner/name；否则 metadata.github_repo。
 *
 * F1（design D5）：算出 canonicalDomain 后无条件抑制 `github.com`（不 gate 在 githubRepo），
 * 抑制任何来源含 url 推导与 `meta.canonical_domain` 显式值。
 */
export function extractProductMergeKeys(input: ProductKeyInput): ProductMergeKeys {
  const meta = input.metadata ?? {};
  const slug = asString(meta.product_hunt_slug);
  const website = asString(meta.website) ?? asString(input.url);

  const canonicalUrl = normalizeUrl(website);
  let canonicalDomain =
    asString(meta.canonical_domain) ?? extractCanonicalDomain(canonicalUrl);

  // F1 无条件抑制：github.com 非有意义产品域，github 产品用 github_repo 作精确键、不靠域合并。
  if (canonicalDomain === 'github.com') canonicalDomain = null;

  const githubRepo =
    normalizeGithubRepo(website) ?? asString(meta.github_repo);

  return {
    canonicalDomain,
    githubRepo,
    productHuntSlug: slug,
  };
}

/**
 * 由 `canonical_domain` 严格构造 `https://<domain>`（裸域 / host:port），畸形降级 null。
 *
 * `ai_products.canonical_domain` 是无 scheme/path 的裸域（product-collapse 写入端规范化），
 * 但历史/异常数据可能含 scheme / path / 空白 → 须严格校验防拼出坏链接（如 `https://https://…`）。
 * 校验：不含空白、不含 `://`，且 `new URL('https://'+d)` 试构造后 `host===d`（保留合法带端口域，
 * 如 `example.com:8080`，仍挡 path/凭据/空白等畸形）、`pathname==='/'`、无 search/hash。
 *
 * 此为「域→URL 域校验」的单一 SOT：`resolveProductUrl` 的第①级与
 * `mcp/lib/canonical-url.ts:productCanonicalUrl` 均经它，避免 search 与 get_today 域校验谓词漂移。
 */
function domainToUrl(domain: string | null | undefined): string | null {
  const d = domain;
  if (d && !/\s/.test(d) && !d.includes('://')) {
    try {
      const u = new URL(`https://${d}`);
      if (u.host === d && u.pathname === '/' && !u.search && !u.hash) {
        return `https://${d}`;
      }
    } catch {
      /* 畸形 → 保持 null */
    }
  }
  return null;
}

/**
 * 产品官网链接回退链（确定性纯函数，design D5）。push 与 MCP get_today 共用一份。
 *
 * 解决「纯 GitHub 仓库类产品（`canonical_domain` 空、仅 `github_repo`）在新品段丢官网链接」
 * （生产实锤 `themartiano/luz`）。按优先级回退、每级畸形即落下一级、皆空/畸形 → null：
 *   ① `canonical_domain` → `https://<domain>`（沿用 domainToUrl 的严格畸形校验）。
 *   ② `github_repo`（归一 `owner/name`、恰两段非空）→ `https://github.com/<owner>/<name>`。
 *   ③ `product_hunt_slug`（**含 `/` 或空白即判畸形、落 null**，不 `%2F` 编码后强拼）
 *      → `https://www.producthunt.com/posts/<slug>`。
 *
 * **零 env/db/config 依赖**（与 extractProductMergeKeys 同 leaf）：产出的 URL 仅供**渲染/还原**，
 * **不**参与跨段去重对齐（后者用 ai_products 存储三键字段，见 daily-intel-pipeline）。
 *
 * @param canonicalDomain  ai_products.canonical_domain（裸域，可空）。
 * @param githubRepo       ai_products.github_repo（`owner/name`，可空）。
 * @param productHuntSlug  ai_products.product_hunt_slug（PH 原生 slug，可空）。
 * @returns                合法时回退链产出的 URL，皆空/畸形时 null（渲染降级纯产品名）。
 */
export function resolveProductUrl(
  canonicalDomain: string | null | undefined,
  githubRepo: string | null | undefined,
  productHuntSlug: string | null | undefined,
): string | null {
  // ① canonical_domain（沿用严格畸形校验，畸形落下一级）。
  const domainUrl = domainToUrl(canonicalDomain);
  if (domainUrl) return domainUrl;

  // ② github_repo：恰 `owner/name` 两段且各非空才拼，否则落下一级（防 `github.com//`、`/x` 等）。
  const repo = asString(githubRepo);
  if (repo) {
    const segments = repo.split('/');
    if (
      segments.length === 2 &&
      segments[0]!.trim().length > 0 &&
      segments[1]!.trim().length > 0 &&
      !/\s/.test(repo)
    ) {
      return `https://github.com/${repo}`;
    }
  }

  // ③ product_hunt_slug：含 `/` 或空白即判畸形、落 null（不 `%2F` 编码后强拼）；通过则直接拼。
  const slug = asString(productHuntSlug);
  if (slug && !slug.includes('/') && !/\s/.test(slug)) {
    return `https://www.producthunt.com/posts/${slug}`;
  }

  return null;
}
