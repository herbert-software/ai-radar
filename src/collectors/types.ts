/**
 * 三源 Collector 的共享类型与横切工具（source-collectors，QA §10.1）。
 *
 * 本模块只承载「统一输出结构 + 重试 + 错误日志」这类与具体源无关的共性，
 * 不含任何抓取逻辑。各源 collector（rss / hacker-news / github）产出 `CollectedItem`，
 * 统一交由 store.ts 写入 raw_items。
 *
 * 不变量（design D7 / spec / 关键不变量）：
 * - 统一结构含 source / source_item_id / url / title / content / published_at / raw_type。
 * - source_item_id **绝不为 NULL**：fallback 链由各 collector 在产出时落实
 *   （guid/item id/repo id → canonical_url → sha256(title‖content)）；store 层兜底再校验一次。
 * - 所有外部网络调用经 `withRetry` 包裹：有限重试 + 失败记错误日志，绝不静默吞掉。
 */
import { sha256Hex } from '../dedup/normalize.js';
import { sanitizeText } from './sanitize.js';

/**
 * 源标识枚举（写入 raw_items.source，如实标记来源）。
 * P2 扩入 `arxiv`（论文，仅沉淀）与 `product_hunt`（产品，先落 raw_items 再确定性塌缩进 ai_products）。
 * `show_hn`（HN「Show HN」经 Algolia，产品流，rawType='product' 进既有产品塌缩；与 `hacker_news`
 * Firebase 综合新闻流 rawType='post' 独立 source，不复用同一命名空间，见 design D2）。
 * 扩源第一梯队（add-tier1-ai-sources）新增两个**新采集器机制**源：
 * - `hugging_face_papers`：HF 官方 JSON API（`daily_papers`）每日精选论文，rawType='paper'、collapsed=true
 *   仅沉淀（与 arXiv 同口径，不进事件/日报/推送），来源身份由 metadata 承载、不受 RSS vendor 约束。
 * - `sitemap`：配置驱动的 sitemap 增量采集器（首期 Anthropic News），从 sitemap.xml diff 出窗内未见
 *   URL 后 per-article 取 og: 标签，rawType='news' 进日报；`source` 为通用机制类、具体 lab 由
 *   metadata.vendor 区分（与 RSS 的 source='rss'+vendor 同范式，可扩展到其他有 sitemap 的 lab）。
 * 下游路由一律按 raw_type 不按 source（混用机制类 rss/sitemap 与平台类 arxiv/product_hunt）。
 */
export type CollectorSource =
  | 'rss'
  | 'hacker_news'
  | 'github'
  | 'arxiv'
  | 'product_hunt'
  | 'show_hn'
  | 'hugging_face_papers'
  | 'sitemap';

/**
 * 统一采集输出结构（对齐 QA §10.1）。
 * 这是 collector 唯一对外契约；store.ts 据此写 raw_items 并在入库时即时生成
 * canonical_url / title_hash（复用 dedup/normalize.ts），collector 不直接碰这两列。
 */
export interface CollectedItem {
  /** 来源，如实标记（rss / hacker_news / github）。 */
  source: CollectorSource;
  /**
   * 源内稳定且**非空**标识。fallback 链由各 collector 落实：
   * 稳定原生 id（guid / HN item id / repo id）→ canonical_url → sha256(title‖content)。
   * 绝不允许为空串/NULL（否则 UNIQUE(source, NULL) 放行多行，源内幂等失效）。
   */
  sourceItemId: string;
  /** 原始 url（可空，如纯文本 HN Ask 帖）；store 据此即时生成 canonical_url。 */
  url: string | null;
  /** 标题（raw_items.title 为 NOT NULL，collector 必须保证非空字符串）。 */
  title: string;
  /** 正文/摘要（可空）。 */
  content: string | null;
  /** 发布时间（可空）。 */
  publishedAt: Date | null;
  /** 条目类型：news / repo / post / paper / product 等（写入 raw_items.raw_type）。 */
  rawType: string;
  /** 可选的附加元数据，写入 raw_items.metadata（与 normalizer_version 合并）。 */
  metadata?: Record<string, unknown> | undefined;
  /**
   * 入库时的 collapsed 标记（默认 false，由 store 透传）。
   * arXiv 论文 P2 仅作数据沉淀、无任何下游消费，故入库即置 `collapsed=true`，
   * 使事件塌缩入口（只扫 collapsed=false）不每轮重扫这些论文行（与新闻行「塌缩后置 true」对称，
   * 避免被排除的 paper 行永远 collapsed=false 致每轮工作量随累计行数线性无界增长）。
   */
  collapsed?: boolean | undefined;
}

/**
 * 内容哈希：`sha256(title ‖ content)`，作为 source_item_id 的**终端 fallback**。
 * 当稳定原生 id 与 canonical_url 皆缺时使用，保证 source_item_id 绝不为 NULL。
 * title 必为非空（raw_items.title NOT NULL），故哈希输入恒非空，结果稳定可比。
 */
export function contentHash(title: string, content: string | null | undefined): string {
  return sha256Hex(`${title}${content ?? ''}`);
}

// 剔 NUL/C0 控制字符（保留 \t\n\r）与 lone surrogate（保留合法 emoji 代理对）：
// 防原始/实体危险字节进 title/content → Postgres text INSERT 中止整批（store 阶段不被 allSettled 隔离）
// + 破坏下游 JSON.stringify。覆盖实体解码值与 og content 里的原始字节。
// 实现委托到 collectors/sanitize.ts 的 sanitizeText（单一净化 SOT）：store 层全源统一净化与各采集器
// 自层纵深防御共用同一码点逻辑，杜绝两份正则漂移。本导出保留向后兼容（sitemap / hf-papers 仍引用）。
export const stripUnsafeChars = sanitizeText;

/**
 * HN 帖式前缀（`Show`/`Ask`/`Launch`/`Tell` + `HN`）——行首锚定、大小写不敏感。
 *
 * 这四类是 HN 平台约定的**非综合新闻帖**：Show HN/Launch HN 是产品/公司发布帖、Ask HN/Tell HN
 * 是提问/告示帖，结构上不属于「要闻」（行业新闻事件）。综合新闻流采集器（hacker-news.ts）据此把它们
 * 排除，避免与产品发现源（show_hn）构成同一项目双段重复。
 *
 * **刻意比 `show-hn.ts` 的 `SHOW_HN_PREFIX_RE` 宽，二者不可「统一」**：
 * - 本正则尾部用 `\b` 词边界，**不强制分隔符**——既要拦 `Show HN: foo` / `Ask HN - bar`，
 *   也要拦 `Show HN` 后接空白或行尾的裸帖式标题（综合流的目标是「按帖类排除」，宁可宽）。
 * - `SHOW_HN_PREFIX_RE` 尾部强制 `:`/`-`/`–`/`—` 及空白分隔符——因它要**剥前缀取产品名**，
 *   必须精确切到分隔符后的产品名，宽匹配会误吞正文。
 * 两者目标不同（排除 vs 剥离）、行为刻意分歧，勿合并。
 */
const HN_NON_NEWS_PREFIX_RE = /^\s*(show|ask|launch|tell)\s+hn\b/i;

/**
 * 判定 HN 原始标题是否为帖式（非综合新闻）帖——供 hacker-news.ts 综合新闻流采集器排除使用。
 * 行首锚定（正文中部出现 "Show HN" 不误判）、大小写不敏感；null/undefined 入参返回 false（不抛）。
 */
export function isHackerNewsNonNewsPost(rawTitle: string | null | undefined): boolean {
  if (rawTitle == null) return false;
  return HN_NON_NEWS_PREFIX_RE.test(rawTitle);
}

/** 错误日志 sink 类型；默认 console.error，便于测试注入断言。 */
export type LogError = (message: string, detail: unknown) => void;

export const defaultLogError: LogError = (message, detail) =>
  console.error(`[collector] ${message}`, detail);

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3。 */
  maxAttempts?: number | undefined;
  /** 重试基础退避毫秒（指数退避：base * 2^(n-1)），默认 0（便于单测不等待）。 */
  baseDelayMs?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入的 sleep 实现，默认真实 setTimeout；测试可注入立即返回的桩。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** 标签，用于日志定位是哪个源/哪次调用。 */
  label?: string | undefined;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 有限重试包裹器（横切不变量：外部调用带重试 + 错误日志）。
 *
 * - 每次失败记录错误日志（非静默），按指数退避重试；
 * - 重试耗尽后抛出最后一次错误（由调用方/`Promise.allSettled` 捕获为单源失败，不拖垮整批）。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 0;
  const logError = options.logError ?? defaultLogError;
  const sleep = options.sleep ?? realSleep;
  const label = options.label ?? 'external-call';

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      logError(`${label}：第 ${attempt}/${maxAttempts} 次调用失败`, error);
      if (attempt < maxAttempts && baseDelayMs > 0) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} 在 ${maxAttempts} 次尝试后仍失败：${String(lastError)}`);
}
