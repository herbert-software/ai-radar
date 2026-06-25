/**
 * Model Radar（P5 / 5b，design D14）三档抓取的 BullMQ 四件套（http + browser 两条独立链）。
 *
 * 对齐 `src/pipeline/alert-queue.ts` 范式：每队列给齐 `*_QUEUE`/`*_JOB` 常量 + `create*Worker` +
 * `schedule*` + payload shape + `defaultJobOptions{attempts, exponential backoff, removeOnComplete/Fail}`；
 * 重试耗尽**保留 failed job** 供人工排查/重放（**失败不改事实**——抓取本就只 propose）。
 *
 * - http 档：日级 cron（`MR_SCRAPE_HTTP_CRON`），主镜像可跑（无 Playwright 依赖）。
 * - browser 档：周级 cron（`MR_SCRAPE_BROWSER_CRON`），**独立 entrypoint + 独立镜像**（browser-worker-main.ts，design D15）；
 *   本文件给出 queue/worker 工厂，由 browser-worker-main 装配（worker-main.ts 不注册 browser 链）。
 *
 * 实际抓取业务在 `runScrapeTier`（纯顺序：按档载源 → 逐源 detectSourceChange，per-source 隔离失败）。
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db as defaultDb } from '../../db/index.js';
import { mrSource } from '../../db/schema.js';
import {
  detectSourceChange,
  type ScrapeSource,
  type DetectChangeOptions,
} from './fingerprint.js';
import { fetchWithBrowser, type BrowserFetchOptions } from './browser-tier.js';

type DbLike = typeof defaultDb;

/** http 档队列/job 名（独立调度链）。 */
export const MR_SCRAPE_HTTP_QUEUE = 'mr-scrape-http';
export const MR_SCRAPE_HTTP_JOB = 'mr-scrape-http';
/** browser 档队列/job 名（独立调度链 + 独立镜像）。 */
export const MR_SCRAPE_BROWSER_QUEUE = 'mr-scrape-browser';
export const MR_SCRAPE_BROWSER_JOB = 'mr-scrape-browser';

const HTTP_CRON_JOB_ID = 'mr-scrape-http-cron';
const BROWSER_CRON_JOB_ID = 'mr-scrape-browser-cron';

/** 抓取 job payload（cron 触发不带；预留手动指定 source ids 子集）。 */
export interface ScrapeJobData {
  /** 仅抓这些 source id（手动；cron 触发不带 → 抓该档全部）。 */
  sourceIds?: string[];
}

/** 单档抓取结果（可观测；逐源 outcome 计数）。 */
export interface RunScrapeTierResult {
  tier: 'http' | 'browser';
  total: number;
  changed: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

/** BullMQ 连接（复用 env.REDIS_URL；调用方负责 quit）。 */
export function buildScrapeConnection(): ConnectionOptions {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

function scrapeJobOptions() {
  return {
    attempts: env.MR_SCRAPE_JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 30_000 },
    // 重试耗尽保留 failed job 供人工排查/重放（design D14）。
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  };
}

export function createMrScrapeHttpQueue(
  connection: ConnectionOptions = buildScrapeConnection(),
): Queue<ScrapeJobData> {
  return new Queue<ScrapeJobData>(MR_SCRAPE_HTTP_QUEUE, {
    connection,
    defaultJobOptions: scrapeJobOptions(),
  });
}

export function createMrScrapeBrowserQueue(
  connection: ConnectionOptions = buildScrapeConnection(),
): Queue<ScrapeJobData> {
  return new Queue<ScrapeJobData>(MR_SCRAPE_BROWSER_QUEUE, {
    connection,
    defaultJobOptions: scrapeJobOptions(),
  });
}

/** 注册 http 档日级 cron（幂等：稳定 jobId）。 */
export async function scheduleMrScrapeHttp(
  queue: Queue<ScrapeJobData>,
): Promise<Job<ScrapeJobData>> {
  return queue.upsertJobScheduler(
    HTTP_CRON_JOB_ID,
    { pattern: env.MR_SCRAPE_HTTP_CRON, tz: env.MR_SCRAPE_CRON_TZ },
    { name: MR_SCRAPE_HTTP_JOB, data: {} },
  );
}

/** 注册 browser 档周级 cron（幂等：稳定 jobId）。 */
export async function scheduleMrScrapeBrowser(
  queue: Queue<ScrapeJobData>,
): Promise<Job<ScrapeJobData>> {
  return queue.upsertJobScheduler(
    BROWSER_CRON_JOB_ID,
    { pattern: env.MR_SCRAPE_BROWSER_CRON, tz: env.MR_SCRAPE_CRON_TZ },
    { name: MR_SCRAPE_BROWSER_JOB, data: {} },
  );
}

/** 载入某档的源行（fetch_strategy 过滤；可选 source id 子集）。 */
async function loadSources(
  dbh: DbLike,
  strategy: 'http' | 'browser',
  sourceIds: string[] | undefined,
): Promise<ScrapeSource[]> {
  const rows = await dbh
    .select({
      id: mrSource.id,
      sourceUrl: mrSource.sourceUrl,
      fetchStrategy: mrSource.fetchStrategy,
    })
    .from(mrSource)
    .where(eq(mrSource.fetchStrategy, strategy));
  const set = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
  return set ? rows.filter((r) => set.has(r.id)) : rows;
}

/**
 * 运行单档抓取（纯顺序，逐源 detectSourceChange，per-source try/catch 隔离失败）。
 * **不裹批事务**——每源 compareAndUpdateFingerprint 自治 autocommit，单源失败不拖垮整批。
 */
export async function runScrapeTier(
  tier: 'http' | 'browser',
  options: {
    dbh?: DbLike;
    sourceIds?: string[] | undefined;
    detectOptions?: DetectChangeOptions;
  } = {},
): Promise<RunScrapeTierResult> {
  const dbh = options.dbh ?? defaultDb;
  const sources = await loadSources(dbh, tier, options.sourceIds);
  const result: RunScrapeTierResult = {
    tier,
    total: sources.length,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
  };

  for (const source of sources) {
    try {
      const outcome = await detectSourceChange(dbh, source, options.detectOptions ?? {});
      if (outcome.outcome === 'changed' || outcome.outcome === 'changed-source-flag') {
        result.changed++;
      } else if (outcome.outcome === 'unchanged') {
        result.unchanged++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      // per-source 隔离：只记通用原因 + source id（不泄 IP/拓扑，design 风险节），不改事实。
      result.errors++;
      console.error(
        `[mr-scrape:${tier}] 源抓取失败（已跳过，不改事实）source=${source.id}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}

export interface MrScrapeWorkerOptions {
  connection?: ConnectionOptions;
  /** 透传给 runScrapeTier 的注入点（DI fetch/extractor，测试用）。 */
  detectOptions?: DetectChangeOptions;
  concurrency?: number;
}

/** 创建 http 档 worker（主镜像可跑）。调用方负责 worker.close()。 */
export function createMrScrapeHttpWorker(
  options: MrScrapeWorkerOptions = {},
): Worker<ScrapeJobData, RunScrapeTierResult> {
  const connection = options.connection ?? buildScrapeConnection();
  return new Worker<ScrapeJobData, RunScrapeTierResult>(
    MR_SCRAPE_HTTP_QUEUE,
    async (job) =>
      runScrapeTier('http', {
        sourceIds: job.data?.sourceIds,
        ...(options.detectOptions ? { detectOptions: options.detectOptions } : {}),
      }),
    { connection, concurrency: options.concurrency ?? 1 },
  );
}

/**
 * 创建 browser 档 worker（**仅 browser-worker-main.ts 装配 + 独立镜像**，design D15）。
 * 默认 detectOptions 注入 browser-tier 的 `fetchWithBrowser`（Playwright 沙箱锁定）。
 */
export function createMrScrapeBrowserWorker(
  options: MrScrapeWorkerOptions & { browserOptions?: BrowserFetchOptions } = {},
): Worker<ScrapeJobData, RunScrapeTierResult> {
  const connection = options.connection ?? buildScrapeConnection();
  const detectOptions: DetectChangeOptions = {
    ...options.detectOptions,
    // browser 档默认取页器（沙箱锁定 + 硬超时杀进程树）。
    fetchBrowser: async (source) =>
      fetchWithBrowser(source.sourceUrl, options.browserOptions ?? {}),
  };
  return new Worker<ScrapeJobData, RunScrapeTierResult>(
    MR_SCRAPE_BROWSER_QUEUE,
    async (job) =>
      runScrapeTier('browser', {
        sourceIds: job.data?.sourceIds,
        detectOptions,
      }),
    { connection, concurrency: options.concurrency ?? 1 },
  );
}
