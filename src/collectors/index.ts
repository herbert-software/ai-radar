/**
 * 三源采集编排（source-collectors，design D7）。
 *
 * 用 `Promise.allSettled` 并发跑 RSS / Hacker News / GitHub 三源：
 * - 单源失败记错误日志、不拖垮整批（其余源照常完成）；
 * - 全部源产出的统一结构条目汇总后，统一交 store 写入 raw_items（源内幂等）。
 *
 * 本模块是 collector 的对外入口，被 daily-intel-pipeline 的 runDailyWorkflow 在 collect
 * 阶段调用（编排由别组实现，本组只提供 `collectAllSources`）。塌缩成 event 是下游职责。
 */
import { collectRss, type RssCollectorOptions } from './rss.js';
import {
  collectHackerNews,
  type HackerNewsCollectorOptions,
} from './hacker-news.js';
import { collectGitHub, type GitHubCollectorOptions } from './github.js';
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
export { storeCollectedItems } from './store.js';

export interface CollectAllOptions {
  rss?: RssCollectorOptions;
  hackerNews?: HackerNewsCollectorOptions;
  github?: GitHubCollectorOptions;
  logError?: LogError;
  /**
   * 注入各源采集函数（默认真实 collector），便于单测在不触网的前提下
   * 模拟「单源失败不拖垮整批」。
   */
  collectors?: {
    rss?: (opts?: RssCollectorOptions) => Promise<CollectedItem[]>;
    hackerNews?: (opts?: HackerNewsCollectorOptions) => Promise<CollectedItem[]>;
    github?: (opts?: GitHubCollectorOptions) => Promise<CollectedItem[]>;
  };
}

export interface CollectAllResult {
  items: CollectedItem[];
  /** 各源结果：成功带条数，失败带 reason（供可观测/告警）。 */
  perSource: Record<CollectorSource, { ok: boolean; count: number; error?: unknown }>;
}

/**
 * 并发采集三源（不入库），单源失败隔离。
 * 返回汇总条目 + 每源成败，供编排层据「采集返回条数=0（三源全挂）」告警（design D8）。
 */
export async function collectAllSources(
  options: CollectAllOptions = {},
): Promise<CollectAllResult> {
  const logError = options.logError ?? defaultLogError;
  const runRss = options.collectors?.rss ?? collectRss;
  const runHn = options.collectors?.hackerNews ?? collectHackerNews;
  const runGitHub = options.collectors?.github ?? collectGitHub;

  console.error('[collect] rss: 开始');
  console.error('[collect] hacker_news: 开始');
  console.error('[collect] github: 开始');

  const [rssResult, hnResult, ghResult] = await Promise.allSettled([
    runRss(options.rss),
    runHn(options.hackerNews),
    runGitHub(options.github),
  ]);

  const items: CollectedItem[] = [];
  const perSource = {} as CollectAllResult['perSource'];

  const absorb = (
    source: CollectorSource,
    result: PromiseSettledResult<CollectedItem[]>,
  ): void => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      perSource[source] = { ok: true, count: result.value.length };
      console.error(`[collect] ${source}: 完成 ${result.value.length} 条`);
    } else {
      perSource[source] = { ok: false, count: 0, error: result.reason };
      logError(`采集源失败（已隔离，不拖垮整批）：${source}`, result.reason);
      console.error(`[collect] ${source}: 失败`);
    }
  };

  absorb('rss', rssResult);
  absorb('hacker_news', hnResult);
  absorb('github', ghResult);

  const okCount = Object.values(perSource).filter((s) => s.ok).length;
  console.error(`[collect] 三源完成：返回 ${items.length} 条，成功 ${okCount}/3 源`);

  return { items, perSource };
}

export interface CollectAndStoreResult extends CollectAllResult {
  store: StoreResult;
}

/**
 * 采集三源并入库（collect 阶段完整动作）：并发采集 → 汇总 → 统一写 raw_items（源内幂等）。
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
