/**
 * arXiv Collector（任务 3.1–3.3，source-collectors / design D3）。
 *
 * 走 OAI-PMH 增量元数据接口（官方推荐的「保持最新」方式）拉新论文，解析为统一
 * `CollectedItem`（`source='arxiv'`、`rawType='paper'`、`source_item_id` 用稳定 arXiv id）。
 *
 * P2 范围限定（spec / design D3）：
 * - **论文仅采集落 `raw_items` 作数据沉淀**，本期**不进事件塌缩 / 不进日报 / 不推送**。
 *   故每条置 `collapsed=true`（入库即标「已按 raw_type 路由/沉淀」），使事件塌缩入口
 *   （只扫 collapsed=false）不每轮重扫这些论文行（dedup/collapse.ts 查询层另加 raw_type 过滤兜底）。
 * - arXiv 是**非实时源**，不接入实时告警路径（实时告警只跑 {rss,hacker_news,github}）。
 *
 * 限流与退避（design D3，2026-02 起 arXiv 收紧 429）：
 * - **单采集进程内** ≥3s 串行节流闸（单连接串行，不以并发绕过限流）。前提：P2 采集由单实例承载，
 *   进程内串行闸即满足 arXiv 侧「1 req/3s」；不承诺跨多 worker 的分布式节流（留后续）。
 * - HTTP 429 → 指数退避重试（复用 withRetry，baseDelay 调大）**且有重试上限**；超限本轮该源
 *   放弃、记 error，由编排层 `Promise.allSettled` 隔离（不无界 pending 拖长 job、不触发全失败告警）。
 * - 鉴权类错误（HTTP 401/403）**不进入退避重试**（重试不可恢复的鉴权错误只是浪费预算），
 *   直接按单源失败抛出、由 allSettled 隔离。
 *
 * OAI-PMH 增量游标 at-least-once（spec / design 待解决问题）：
 * - 游标（上次 harvest 时间戳）**必须在条目成功入库后才推进**——禁止「先推进后入库」（崩在二者间会跳窗漏论文）。
 * - 本模块只**读**游标作 `from` 参数、并在返回结果里给出本轮可推进到的新游标值；**绝不自行推进**。
 *   推进由编排层在 `storeCollectedItems` 成功后调用 `commit` 完成（at-least-once：宁可重抓不可漏窗，
 *   重抓由 `UNIQUE(source, source_item_id)` 幂等吸收）。
 *
 * 依赖注入：`fetchText`（默认 global fetch，返回 OAI-PMH XML 文本）、`sleep`、`now`、`cursor`
 * 均可注入，使单测无需真实网络。
 */
import { env } from '../config/env.js';
import {
  defaultLogError,
  type CollectedItem,
  type LogError,
} from './types.js';

/** arXiv OAI-PMH 基址（ListRecords 动词增量拉取）。 */
const OAI_PMH_BASE = 'https://export.arxiv.org/oai2';

/** arXiv 侧硬限流：每 3 秒不超过 1 个请求。 */
const MIN_REQUEST_INTERVAL_MS = 3000;

/** 鉴权类错误（不进入退避重试，直接隔离）。 */
export class ArxivAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ArxivAuthError';
  }
}

/** 限流错误（HTTP 429，进入退避重试）。 */
export class ArxivRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArxivRateLimitError';
  }
}

/** OAI-PMH XML 文本抓取契约（默认 global fetch；可注入 mock）。 */
export type FetchTextFn = (url: string) => Promise<string>;

/**
 * 游标存储契约（持久化由编排层提供，不在本组 schema 范围内）。
 * - `load()`：读上次 harvest 时间戳（首次为 null → 全量/默认窗口）。
 * - `commit(to)`：把游标推进到 `to`，**只允许在条目成功入库后**由编排层调用（at-least-once）。
 */
export interface ArxivCursorStore {
  load(): Promise<Date | null>;
  commit(to: Date): Promise<void>;
}

export interface ArxivCollectorOptions {
  /** OAI-PMH set（学科分类），默认 cs.AI 等可由编排层配置；默认 'cs'。 */
  set?: string | undefined;
  /** metadataPrefix，默认 'oai_dc'（Dublin Core）。 */
  metadataPrefix?: string | undefined;
  /** 最多翻多少页（resumptionToken 分页），防单轮无界翻页，默认 2。 */
  maxPages?: number | undefined;
  /** 429 退避重试上限（含首次），默认 4。超限本轮放弃。 */
  maxAttempts?: number | undefined;
  /** 429 退避基础毫秒（指数退避，调大以尊重限流），默认 3000。 */
  backoffBaseMs?: number | undefined;
  /** 串行节流最小间隔毫秒，默认 3000（arXiv 硬限流）。 */
  minIntervalMs?: number | undefined;
  /** 注入的 XML 文本抓取实现，默认 global fetch。 */
  fetchText?: FetchTextFn | undefined;
  /** 游标存储（编排层提供）；省略则不带 from、不推进游标。 */
  cursor?: ArxivCursorStore | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** 注入时钟（测试可控），默认 Date.now。 */
  now?: (() => number) | undefined;
}

/**
 * 本轮采集结果：统一条目 + 可推进到的新游标值 + 一个 `commit` 便捷封装。
 * 编排层应在 `storeCollectedItems` 成功后调用 `commit()` 才推进游标（at-least-once）。
 */
export interface ArxivHarvestResult {
  items: CollectedItem[];
  /** 本轮可推进到的新游标（取本轮所见最大 datestamp）；无新条目时为 null（不推进）。 */
  nextCursor: Date | null;
  /** 便捷封装：仅当存在 cursor store 且 nextCursor 非空时，推进游标。供编排层在入库成功后调用。 */
  commit: () => Promise<void>;
}

const defaultFetchText: FetchTextFn = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ai-radar (arxiv OAI-PMH harvester)' },
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (res.status === 429) {
    throw new ArxivRateLimitError(`arXiv OAI-PMH 429 限流：${url}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ArxivAuthError(res.status, `arXiv OAI-PMH ${res.status} 鉴权失败：${url}`);
  }
  if (!res.ok) {
    throw new Error(`arXiv OAI-PMH ${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
};

/** 解析出的单条 OAI-PMH record 的最小视图。 */
export interface ArxivRecord {
  /** 稳定 arXiv id（如 `2406.12345` 或带版本的 OAI identifier），作 source_item_id。 */
  identifier: string;
  title: string;
  abstract: string | null;
  /** 论文绝对 URL（abs 页）。 */
  url: string | null;
  /** OAI datestamp（用于推进游标）。 */
  datestamp: Date | null;
}

/** 解析后的一页结果：records + 下一页 resumptionToken（无则 null）。 */
export interface ArxivPage {
  records: ArxivRecord[];
  resumptionToken: string | null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function firstTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1]!.trim()) : null;
}

/** 从 dc:identifier 列表里挑一个 arxiv abs URL（作 url）。 */
function pickAbsUrl(recordXml: string): string | null {
  const re = /<(?:[\w-]+:)?identifier[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?identifier>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(recordXml)) !== null) {
    const val = decodeXmlEntities(m[1]!.trim());
    if (/^https?:\/\/arxiv\.org\/abs\//i.test(val)) return val;
  }
  return null;
}

function toDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 解析一页 OAI-PMH ListRecords XML。
 * identifier 取 `<header><identifier>`（OAI 稳定标识，如 `oai:arXiv.org:2406.12345`）。
 * 缺 identifier 的 record 跳过（无稳定 id 不入库，避免 source_item_id 不稳）。
 */
export function parseOaiListRecords(xml: string): ArxivPage {
  const records: ArxivRecord[] = [];

  const recordRe = /<record[^>]*>([\s\S]*?)<\/record>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = recordRe.exec(xml)) !== null) {
    const recordXml = rm[1]!;
    // header 段单独取（identifier/datestamp 在 header 内，metadata 内 dc:identifier 是 URL）。
    const headerMatch = /<header[^>]*>([\s\S]*?)<\/header>/i.exec(recordXml);
    const headerXml = headerMatch ? headerMatch[1]! : '';
    const identifier = firstTag(headerXml, 'identifier');
    if (!identifier) continue; // 无稳定 id → 跳过（绝不用易变值当 source_item_id）。
    const datestamp = toDate(firstTag(headerXml, 'datestamp'));
    const title = firstTag(recordXml, 'title') ?? '';
    const abstract = firstTag(recordXml, 'description');
    const url = pickAbsUrl(recordXml);
    records.push({ identifier, title, abstract, url, datestamp });
  }

  const tokenRaw = firstTag(xml, 'resumptionToken');
  const resumptionToken = tokenRaw && tokenRaw.length > 0 ? tokenRaw : null;

  return { records, resumptionToken };
}

/** 把一条 arXiv record 映射为统一结构。source_item_id 用稳定 arXiv identifier（非空）。 */
export function mapArxivRecord(record: ArxivRecord): CollectedItem {
  return {
    source: 'arxiv',
    sourceItemId: record.identifier,
    url: record.url,
    title: record.title.trim(),
    content: record.abstract,
    publishedAt: record.datestamp,
    rawType: 'paper',
    // P2：论文仅沉淀，入库即置 collapsed=true（无下游消费、不每轮重扫）。
    collapsed: true,
    metadata: { oai_identifier: record.identifier },
  };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 进程内串行节流闸：保证相邻两次请求间隔 ≥ minIntervalMs（单连接串行）。
 * 用模块级 last-request 时间戳实现「单采集进程内」串行（单实例采集假设，design D3）。
 */
let lastRequestAt = 0;
async function throttle(
  minIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const elapsed = now() - lastRequestAt;
  const wait = minIntervalMs - elapsed;
  if (wait > 0) await sleep(wait);
  lastRequestAt = now();
}

/** 测试辅助：重置节流闸内部状态（仅供单测，使各用例互不串扰）。 */
export function __resetArxivThrottleForTest(): void {
  lastRequestAt = 0;
}

/**
 * 采集 arXiv（OAI-PMH 增量），返回统一条目 + 新游标 + commit。
 *
 * - 读游标 → 拼 `from` 参数（at-least-once：只读、不推进）。
 * - 串行节流 ≥3s 抓每一页；429 经 withRetry 退避重试（baseDelay 调大）且有上限，超限抛出本源失败；
 *   401/403 不重试直接抛出。
 * - 跨页用 resumptionToken，最多翻 maxPages 页。
 * - nextCursor 取本轮所见最大 datestamp；commit() 推进游标（编排层应在入库成功后调用）。
 */
export async function harvestArxiv(
  options: ArxivCollectorOptions = {},
): Promise<ArxivHarvestResult> {
  const set = options.set ?? 'cs';
  const metadataPrefix = options.metadataPrefix ?? 'oai_dc';
  const maxPages = options.maxPages ?? 2;
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffBaseMs = options.backoffBaseMs ?? 3000;
  const minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  const fetchText = options.fetchText ?? defaultFetchText;
  const logError = options.logError ?? defaultLogError;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  const fromCursor = options.cursor ? await options.cursor.load() : null;

  /**
   * 抓一页：每次请求前过串行节流闸（≥minIntervalMs）。
   * - 429（ArxivRateLimitError）→ 指数退避重试，**有上限**（maxAttempts）；超限抛出本源失败。
   * - 401/403（ArxivAuthError）→ **不重试**，记 error 后立即抛出（重试不可恢复的鉴权错误只是浪费预算）。
   * - 其余错误（如超时）→ 也走有限重试。
   * 不用 withRetry 的盲重试，以精确区分「鉴权不重试」与「429 有上限退避」。
   */
  const fetchPage = async (url: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await throttle(minIntervalMs, sleep, now);
      try {
        return await fetchText(url);
      } catch (error) {
        lastError = error;
        // 鉴权错误：不进入退避重试，立即抛出（由编排层 allSettled 隔离）。
        if (error instanceof ArxivAuthError) {
          logError(`arXiv 鉴权失败（不重试，直接隔离）：${error.status}`, error);
          throw error;
        }
        const isRate = error instanceof ArxivRateLimitError;
        logError(
          `arxiv:oai-pmh：第 ${attempt}/${maxAttempts} 次${isRate ? '（429 限流）' : ''}失败`,
          error,
        );
        // 达上限：放弃本轮、抛出（不无界 pending 拖长 job）。
        if (attempt >= maxAttempts) break;
        // 指数退避（429 用调大的 baseDelay 尊重限流；429 之外的瞬时错误同样退避）。
        if (backoffBaseMs > 0) await sleep(backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`arxiv:oai-pmh 在 ${maxAttempts} 次尝试后仍失败：${String(lastError)}`);
  };

  const buildFirstUrl = (): string => {
    const params = new URLSearchParams({
      verb: 'ListRecords',
      metadataPrefix,
      set,
    });
    if (fromCursor) params.set('from', fromCursor.toISOString().slice(0, 10));
    return `${OAI_PMH_BASE}?${params.toString()}`;
  };
  const buildResumeUrl = (token: string): string =>
    `${OAI_PMH_BASE}?${new URLSearchParams({ verb: 'ListRecords', resumptionToken: token }).toString()}`;

  const items: CollectedItem[] = [];
  let maxDatestamp: Date | null = null;
  let url = buildFirstUrl();

  for (let page = 0; page < maxPages; page++) {
    const xml = await fetchPage(url);
    const parsed = parseOaiListRecords(xml);
    for (const rec of parsed.records) {
      items.push(mapArxivRecord(rec));
      if (rec.datestamp && (!maxDatestamp || rec.datestamp > maxDatestamp)) {
        maxDatestamp = rec.datestamp;
      }
    }
    if (!parsed.resumptionToken) break;
    url = buildResumeUrl(parsed.resumptionToken);
  }

  const nextCursor = maxDatestamp;
  const cursorStore = options.cursor;
  const commit = async (): Promise<void> => {
    // 只在入库成功后由编排层调用：推进游标到本轮最大 datestamp（at-least-once）。
    if (cursorStore && nextCursor) await cursorStore.commit(nextCursor);
  };

  return { items, nextCursor, commit };
}

/**
 * registry 适配器：符合 collector registry 的 `collect(opts) => Promise<CollectedItem[]>` 契约。
 *
 * 注意游标推进语义：本函数返回 items 供编排层入库；游标的推进**不在此处**（at-least-once 要求
 * 入库成功后才推进）。编排层若需推进游标，应改用 `harvestArxiv` 拿到 `commit` 并在 store 成功后调用。
 * 单源失败（429 达上限放弃 / 超时 / 鉴权）在此抛出，由编排层 allSettled 隔离、不触发全失败告警。
 */
export async function collectArxiv(
  options: ArxivCollectorOptions = {},
): Promise<CollectedItem[]> {
  const result = await harvestArxiv(options);
  return result.items;
}
