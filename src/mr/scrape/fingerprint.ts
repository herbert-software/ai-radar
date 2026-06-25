/**
 * Model Radar（P5 / 5b，design D7）三档抓取变更检测编排器（**只 propose，不改事实**）。
 *
 * 流程（单源）：
 * ① 按 `mr_source.fetch_strategy ∈ {http,browser,manual}` 分档取页（manual 不发请求 → 早退）；
 * ② `http` 档守 robots（禁则不抓）+ `safeFetch`（SSRF chokepoint + 裸请求 + 每跳重验）；
 * ③ per-source extractor 抽「价格/额度区域」归一文本 → `content_fingerprint = sha256`（不引 cheerio）；
 * ④ best-effort 写快照（design D13，flag 不依赖其存活）；
 * ⑤ 经 `src/mr/write/fingerprint-store.ts` **原子 compare-and-update**：真变才更新指纹 + 定位打标，
 *    无变化只刷 last_checked（stale 重试 no-op）。
 *
 * **结构守卫**：本文件只 import `src/mr/write/`（fingerprint-store）+ 同目录 scrape 工具，
 * **绝不 import `src/mr/ingest/`**（eslint no-restricted-imports 兜底，design D7）——抓取改不了事实。
 *
 * DI：`fetchHttp`（默认 `safeFetch`）/ `fetchBrowser`（默认 browser-tier）/ `extractor` / `robotsCheck`
 * 均可注入桩，使单测不触网（仿 collectors/rss.ts 范式）。
 */
import { createHash } from 'node:crypto';
import { db as defaultDb } from '../../db/index.js';
import {
  compareAndUpdateFingerprint,
  type FingerprintUpdateOutcome,
} from '../write/fingerprint-store.js';
import {
  safeFetch,
  isAllowedByRobots,
  defaultPriceRegionExtractor,
  type PriceRegionExtractor,
  type SafeFetchOptions,
} from './http-tier.js';
import { fetchManual } from './manual-tier.js';
import { writeSnapshot } from './snapshot.js';

type DbLike = typeof defaultDb;

/** 待检测的源（从 mr_source 行投影；fetch_strategy 已经 5a Zod 闸校验过）。 */
export interface ScrapeSource {
  id: string;
  sourceUrl: string;
  fetchStrategy: string; // 'http' | 'browser' | 'manual'
}

/** 单源抓取取页的注入契约（返回页面文本；null = 未抓/manual）。 */
export type FetchPageFn = (
  source: ScrapeSource,
  options?: SafeFetchOptions,
) => Promise<string | null>;

export interface DetectChangeOptions {
  /** http 档取页（默认经 safeFetch + robots）。测试注入桩免触网。 */
  fetchHttp?: FetchPageFn | undefined;
  /** browser 档取页（默认 browser-tier；测试注入桩）。 */
  fetchBrowser?: FetchPageFn | undefined;
  /** 价格区域 extractor（默认全页归一）。 */
  extractor?: PriceRegionExtractor | undefined;
  /** robots 检查（默认 isAllowedByRobots）。测试注入桩。 */
  robotsCheck?: ((url: string, opts?: SafeFetchOptions) => Promise<boolean>) | undefined;
  /** 透传给 safeFetch / robots 的 SSRF 注入点（allowlist/resolveAll，测试用）。 */
  fetchOptions?: SafeFetchOptions | undefined;
  /** 是否写快照（默认 true；测试可关）。 */
  writeSnapshotFile?: boolean | undefined;
  /** 注入 compare-and-update（默认 fingerprint-store；测试桩免 DB，断言「真变才打标」编排）。 */
  compareFn?:
    | ((
        dbh: DbLike,
        sourceId: string,
        fp: string,
        reason: string,
      ) => Promise<FingerprintUpdateOutcome>)
    | undefined;
}

/** sha256 hex 指纹。 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 默认 http 取页：守 robots → safeFetch → 取 body。robots 禁则返回 null（不抓）。 */
const defaultFetchHttp: FetchPageFn = async (source, options) => {
  const allowed = await isAllowedByRobots(source.sourceUrl, options);
  if (!allowed) return null; // robots 禁止路径不抓（合规需求）。
  const res = await safeFetch(source.sourceUrl, options);
  return res.body;
};

/**
 * 检测单源变更（design D7：只 propose 不改事实）。
 *
 * @param dbh db 实例（compareAndUpdateFingerprint 自开 transaction）。
 * @returns compare-and-update 结果，或 `{outcome:'skipped'}`（manual / robots 禁 / 抓取失败）。
 */
export async function detectSourceChange(
  dbh: DbLike,
  source: ScrapeSource,
  options: DetectChangeOptions = {},
): Promise<FingerprintUpdateOutcome | { outcome: 'skipped' }> {
  // manual 档：不发请求（design D7/合规）。
  if (source.fetchStrategy === 'manual') {
    fetchManual(); // 显式表达「不抓」，无副作用。
    return { outcome: 'skipped' };
  }

  const extractor = options.extractor ?? defaultPriceRegionExtractor;
  const fetchOptions = options.fetchOptions;

  let body: string | null;
  if (source.fetchStrategy === 'browser') {
    const fetchBrowser = options.fetchBrowser;
    if (!fetchBrowser) {
      // browser 档默认实现是独立 worker entrypoint（browser-tier，依赖 playwright + egress）；
      // 此处不内联默认 import（隔离 playwright 使 http/manual 链可独立编译运行，design 约束）。
      return { outcome: 'skipped' };
    }
    body = await fetchBrowser(source, fetchOptions);
  } else if (source.fetchStrategy === 'http') {
    const fetchHttp = options.fetchHttp ?? defaultFetchHttp;
    const robotsCheck = options.robotsCheck;
    if (robotsCheck && !(await robotsCheck(source.sourceUrl, fetchOptions))) {
      return { outcome: 'skipped' }; // 注入 robots 桩禁则不抓。
    }
    body = await fetchHttp(source, fetchOptions);
  } else {
    // 未知 strategy → fail-closed 不发请求（DB 侧 Zod 已限 {http,browser,manual}，此为纵深防御）。
    return { outcome: 'skipped' };
  }

  if (body == null) return { outcome: 'skipped' }; // 未抓到（robots 禁/manual）。

  const region = extractor(body, source.sourceUrl);
  const fp = fingerprint(region);

  // best-effort 写快照（flag 不依赖其存活，design D13）。
  if (options.writeSnapshotFile !== false) {
    await writeSnapshot(source.id, region).catch(() => {});
  }

  // 原子 compare-and-update + 定位打标（只 propose，design D7）。
  const compare = options.compareFn ?? compareAndUpdateFingerprint;
  return compare(
    dbh,
    source.id,
    fp,
    `抓取检测到页面内容变动（源 ${source.id}），请复核价格/额度/兼容事实`,
  );
}
