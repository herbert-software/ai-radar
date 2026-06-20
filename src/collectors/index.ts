/**
 * 采集编排（source-collectors，design D1/D7）。
 *
 * **数组驱动的 collector registry**（design D1）：registry 为 `Array<{ source, collect }>`，
 * `collectAllSources` 用 `Promise.allSettled(registry.map(c => c.collect()))` 并发跑、按
 * source 字段聚合 `perSource`。新增一个写 `raw_items` 的源**只需向 registry 注册**该 collector，
 * 不改既有源的编排分支（消除「加一源改两处」，对齐 spec「registry 注册即接入新源」）。
 *
 * registry 支持**按 source 筛选子集**（`collectSources(registry, allowed)`）。三视图（design D6）：
 *   - **全集**（`collectAllSources` / `buildRegistry` 全量）：日报工作流采全部已注册源（含 arXiv 仅沉淀）。
 *   - **实时新闻子集** `REALTIME_NEWS_SOURCES = {rss, hacker_news, github}`：实时告警高频链只调这三源
 *     （避免高频链被迫连 arXiv 非实时 / PH 配额受限一起跑，见 realtime-alerts）。
 *   - **产品源子集** `PRODUCT_SOURCES = {product_hunt, show_hn}`：product-digest 产品发现链采全部产品源
 *     → 紧接同链产品塌缩（链路显式闭合，见 product-discovery / design D6）。
 * 两子集均为手工维护的字面量，**有意不归属任一子集的源**（如 arXiv 仅日报全集沉淀、无实时/产品消费）。
 *
 * 单源失败隔离（不变量）：某源抛错（如 GitHub 限流 / arXiv 429 达上限放弃 / 鉴权）被记错误日志、
 * 其余源照常完成，整批采集不中止。塌缩成 event 是下游职责。
 *
 * 本模块是 collector 的对外入口，被 daily-intel-pipeline 的 runDailyWorkflow 在 collect
 * 阶段调用（编排由别组实现，本组只提供 `collectAllSources` / `collectSources`）。
 */
import { collectRss, type RssCollectorOptions } from './rss.js';
import {
  collectHackerNews,
  type HackerNewsCollectorOptions,
} from './hacker-news.js';
import { collectGitHub, type GitHubCollectorOptions } from './github.js';
import { collectArxiv, type ArxivCollectorOptions } from './arxiv.js';
import {
  collectProductHunt,
  type ProductHuntCollectorOptions,
} from './product-hunt.js';
import {
  collectShowHn,
  type ShowHnCollectorOptions,
} from './show-hn.js';
import {
  collectHfPapers,
  type HfPapersCollectorOptions,
} from './hf-papers.js';
import {
  collectSitemaps,
  type SitemapCollectorOptions,
} from './sitemap.js';
import {
  collectBlogger,
  type BloggerCollectorOptions,
} from './blogger.js';
import {
  storeCollectedItems,
  type StoreOptions,
  type StoreResult,
} from './store.js';
import {
  defaultLogError,
  type CollectedItem,
  type CollectorSource,
  type LogError,
} from './types.js';

export type { CollectedItem, CollectorSource } from './types.js';
export { collectRss } from './rss.js';
export { collectHackerNews } from './hacker-news.js';
export { collectGitHub } from './github.js';
export { collectArxiv, harvestArxiv } from './arxiv.js';
export { collectProductHunt } from './product-hunt.js';
export { collectShowHn } from './show-hn.js';
export { collectHfPapers } from './hf-papers.js';
export { collectSitemaps } from './sitemap.js';
export { collectBlogger } from './blogger.js';
export { storeCollectedItems } from './store.js';

/** 单个源在本轮采集中可用的注入选项（按 source 路由）。 */
export interface PerSourceOptions {
  rss?: RssCollectorOptions;
  hackerNews?: HackerNewsCollectorOptions;
  github?: GitHubCollectorOptions;
  arxiv?: ArxivCollectorOptions;
  productHunt?: ProductHuntCollectorOptions;
  showHn?: ShowHnCollectorOptions;
  hfPapers?: HfPapersCollectorOptions;
  sitemap?: SitemapCollectorOptions;
  blogger?: BloggerCollectorOptions;
}

/** registry 单项契约（design D1）：标记 source + 无参可调的 collect 闭包。 */
export interface CollectorRegistryEntry {
  source: CollectorSource;
  collect: () => Promise<CollectedItem[]>;
}

export interface CollectAllOptions extends PerSourceOptions {
  logError?: LogError | undefined;
  /**
   * 注入各源采集函数（默认真实 collector），便于单测在不触网的前提下
   * 模拟「单源失败不拖垮整批」「registry 新增一源后被并发调用」。
   * 键为 source 字段；提供则覆盖该源默认 collector。
   */
  collectors?: Partial<
    Record<CollectorSource, (opts?: never) => Promise<CollectedItem[]>>
  > & {
    rss?: (opts?: RssCollectorOptions) => Promise<CollectedItem[]>;
    hackerNews?: (opts?: HackerNewsCollectorOptions) => Promise<CollectedItem[]>;
    github?: (opts?: GitHubCollectorOptions) => Promise<CollectedItem[]>;
    arxiv?: (opts?: ArxivCollectorOptions) => Promise<CollectedItem[]>;
    productHunt?: (
      opts?: ProductHuntCollectorOptions,
    ) => Promise<CollectedItem[]>;
    showHn?: (opts?: ShowHnCollectorOptions) => Promise<CollectedItem[]>;
    hfPapers?: (opts?: HfPapersCollectorOptions) => Promise<CollectedItem[]>;
    sitemap?: (opts?: SitemapCollectorOptions) => Promise<CollectedItem[]>;
    blogger?: (opts?: BloggerCollectorOptions) => Promise<CollectedItem[]>;
  };
}

export interface CollectAllResult {
  items: CollectedItem[];
  /** 各源结果：成功带条数，失败带 reason（供可观测/告警）。仅含本轮实际跑的源。 */
  perSource: Partial<
    Record<CollectorSource, { ok: boolean; count: number; error?: unknown }>
  >;
}

/**
 * 构建本轮 collector registry（数组驱动）。
 * 每项 `collect` 是无参闭包，已绑定该源的注入选项 / 注入 collector（默认真实实现）。
 * 新增源只需在此数组追加一项 —— 不改 `collectAllSources` 的并发/聚合逻辑。
 */
export function buildRegistry(
  options: CollectAllOptions = {},
): CollectorRegistryEntry[] {
  const c = options.collectors ?? {};
  return [
    { source: 'rss', collect: () => (c.rss ?? collectRss)(options.rss) },
    {
      source: 'hacker_news',
      collect: () => (c.hackerNews ?? collectHackerNews)(options.hackerNews),
    },
    { source: 'github', collect: () => (c.github ?? collectGitHub)(options.github) },
    { source: 'arxiv', collect: () => (c.arxiv ?? collectArxiv)(options.arxiv) },
    {
      source: 'product_hunt',
      collect: () =>
        (c.productHunt ?? collectProductHunt)(options.productHunt),
    },
    {
      source: 'show_hn',
      collect: () => (c.showHn ?? collectShowHn)(options.showHn),
    },
    {
      source: 'hugging_face_papers',
      collect: () => (c.hfPapers ?? collectHfPapers)(options.hfPapers),
    },
    {
      source: 'sitemap',
      collect: () => (c.sitemap ?? collectSitemaps)(options.sitemap),
    },
    {
      // AI 博主经验链（add-ai-blogger-experience-mining，design D1）：消费 BLOGGER_FEEDS，
      // 由 mapBloggerItem 产出 source='blogger'/raw_type='experience'/collapsed=true。
      // 在日报全集采集；**有意不归 REALTIME_NEWS_SOURCES/PRODUCT_SOURCES 任一子集**（见下两常量护栏）。
      source: 'blogger',
      collect: () => (c.blogger ?? collectBlogger)(options.blogger),
    },
  ];
}

/**
 * 实时新闻源子集（design D6 / realtime-alerts）：高频告警链路只采这三源
 * （排除 arXiv 非实时、Product Hunt 配额受限）。供 `collectSources` 按 source 过滤复用。
 *
 * **维护对称性（前向脆弱护栏，design D6）**：本子集与 `PRODUCT_SOURCES`（见下）均为手工维护的
 * `CollectorSource[]` 字面量，与 `buildRegistry` 源全集独立。新增源（如非目标里预告的 Reddit）须显式
 * 决定归属哪个子集（或有意不归属任一子集，如 arXiv 仅日报全集沉淀、无实时/产品消费）——否则会被静默
 * 排除出实时/产品链。`show_hn` **有意不在此子集**：实时告警消费 ai_news_events，product 不进事件塌缩
 * → 天然不进告警评分链（真正的告警隔离闸是 `raw_type='product'` 路由，非子集成员资格）。
 * `blogger` **有意不在此子集**（add-ai-blogger-experience-mining，design D1）：经验链仅日报内联消费，
 * 无实时告警消费（真正的隔离闸是 `raw_type='experience'` 路由 + `collapsed=true` 沉淀，非子集成员资格）。
 */
export const REALTIME_NEWS_SOURCES: readonly CollectorSource[] = [
  'rss',
  'hacker_news',
  'github',
];

/**
 * 产品源子集（design D6 / product-discovery）：产品发现链路（product-digest）经
 * `collectSources(PRODUCT_SOURCES, ...)` 采全部产品源 → 紧接同链 `collapseUncollapsedProductRawItems`
 * 塌缩进 ai_products（链路显式闭合，不依赖跨 workflow 隐式时序）。
 *
 * 与 `REALTIME_NEWS_SOURCES`（见上）对称的手工维护字面量；`show_hn` 与 `product_hunt` 同属产品源。
 * 有意不归属任一子集的源（如 arXiv 仅日报全集沉淀、`blogger` 仅经验链日报内联消费）不出现在这两个子集里。
 *
 * **跨段去重耦合（回引 `PLATFORM_HOSTS`，design D3）**：新增产品源时，若其**无 website 兜底 URL**
 * 的 host 是「URL 路径而非子域标识产品」的平台 host（如 `github.com`/`producthunt.com`/`npmjs.com`），
 * MUST 同步把该 host 加入 `src/selection/cross-segment-dedup.ts` 的 `PLATFORM_HOSTS` 常量——否则该平台
 * host 的要闻会被跨段去重 mass 误抑制（该常量构建产品域集时剔除其中的 host，见 daily-intel-pipeline）。
 */
export const PRODUCT_SOURCES: readonly CollectorSource[] = [
  'product_hunt',
  'show_hn',
];

/**
 * 并发跑给定 registry 的全部源（不入库），单源失败隔离、按 source 聚合 perSource。
 * 这是 registry 的核心编排：`Promise.allSettled(registry.map(c => c.collect()))`。
 */
export async function runRegistry(
  registry: readonly CollectorRegistryEntry[],
  logError: LogError = defaultLogError,
): Promise<CollectAllResult> {
  for (const entry of registry) {
    console.error(`[collect] ${entry.source}: 开始`);
  }

  const settled = await Promise.allSettled(registry.map((e) => e.collect()));

  const items: CollectedItem[] = [];
  const perSource: CollectAllResult['perSource'] = {};

  settled.forEach((result, idx) => {
    const source = registry[idx]!.source;
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      perSource[source] = { ok: true, count: result.value.length };
      console.error(`[collect] ${source}: 完成 ${result.value.length} 条`);
    } else {
      perSource[source] = { ok: false, count: 0, error: result.reason };
      logError(`采集源失败（已隔离，不拖垮整批）：${source}`, result.reason);
      console.error(`[collect] ${source}: 失败`);
    }
  });

  const okCount = Object.values(perSource).filter((s) => s?.ok).length;
  console.error(
    `[collect] registry 完成：返回 ${items.length} 条，成功 ${okCount}/${registry.length} 源`,
  );

  return { items, perSource };
}

/**
 * 按 source 筛选 registry 的子集后并发采集（design D1 / D6）：
 * 供实时告警高频链路只调 `{rss, hacker_news, github}`、日报工作流调全集。
 * `allowed` 中不在 registry 的 source 被忽略；空交集 → 跑空集（perSource 为空）。
 */
export async function collectSources(
  allowed: readonly CollectorSource[],
  options: CollectAllOptions = {},
): Promise<CollectAllResult> {
  const logError = options.logError ?? defaultLogError;
  const allowedSet = new Set(allowed);
  const registry = buildRegistry(options).filter((e) => allowedSet.has(e.source));
  return runRegistry(registry, logError);
}

/**
 * 并发采集全部已注册源（不入库），单源失败隔离。
 * 返回汇总条目 + 每源成败，供编排层据「采集返回条数=0（全部源挂）」告警。
 */
export async function collectAllSources(
  options: CollectAllOptions = {},
): Promise<CollectAllResult> {
  const logError = options.logError ?? defaultLogError;
  return runRegistry(buildRegistry(options), logError);
}

export interface CollectAndStoreResult extends CollectAllResult {
  store: StoreResult;
}

/**
 * 采集全部源并入库（collect 阶段完整动作）：并发采集 → 汇总 → 统一写 raw_items（源内幂等）。
 * 返回采集与入库统计，供编排层做「采集返回=0」告警与可观测。
 */
export async function collectAndStore(
  options: CollectAllOptions & { dbh?: StoreOptions['dbh'] } = {},
): Promise<CollectAndStoreResult> {
  const logError = options.logError ?? defaultLogError;
  const collected = await collectAllSources(options);
  const store = await storeCollectedItems(collected.items, {
    dbh: options.dbh,
    logError,
  });
  console.error(`[collect] 入库完成：写入 ${collected.items.length} 条`);
  return { ...collected, store };
}
