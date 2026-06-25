/**
 * Model Radar（P5 / 5b，design D10/D12）`http` 档抓取 = 唯一出站原语，必经 SSRF chokepoint。
 *
 * **本文件是 `src/mr/scrape/` 里唯一获 eslint 豁免直调 `node:http(s)` 的地方**（eslint.config.js 对
 * `http-tier.ts`/`ssrf-guard.ts` 放行 `node:http(s)`/`node:dns`，其余 scrape 文件裸调即报错）——
 * 因为 SSRF 守卫必须由它实现（design D10 ④ 用 node:https 原生 lookup，无新依赖）。
 *
 * 安全契约：
 * - **裸请求**（design D12）：`safeFetch` 不接受任何 `headers`/`token` 参数，出站头**恰为** `{User-Agent}`
 *   （固定 `env.MR_SCRAPE_USER_AGENT`），结构上无 `Authorization`/`Cookie`/provider API key。
 * - **每跳重验**（design D10 ⑤）：`redirect` 手动处理——每个 3xx 的 `location` 重跑 `assertUrlAllowed`（scheme+白名单+字面 IP），
 *   超 `MR_SCRAPE_MAX_REDIRECTS` 拒。底层 socket 经 `buildGuardedAgents` 的 lookup 做 DNS-rebind 闭合。
 * - **响应体上限**（design D11）：累计读超 `MR_SCRAPE_MAX_RESPONSE_BYTES` 立即 destroy（防 OOM/DoS）；硬超时 abort。
 *
 * per-source extractor + DI：`fetchFn` 默认 `safeFetch`，测试注入桩免触网（仿 collectors/rss.ts 范式）。
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { env } from '../../config/env.js';
import {
  assertUrlAllowed,
  buildGuardedAgents,
  SsrfBlockedError,
  type GuardedAgents,
  type ResolveAllFn,
} from './ssrf-guard.js';
import { MR_SOURCE_DOMAIN_ALLOWLIST } from './allowlist.js';

/** safeFetch 返回的最小响应视图（只取抓取变更检测需要的字段）。 */
export interface SafeFetchResult {
  status: number;
  /** 最终 URL（跟随并重验后的）。 */
  finalUrl: string;
  /** 响应体文本；若 truncated=true 则为 null，避免上层用截断文本更新指纹。 */
  body: string | null;
  /** 响应体超过上限并被截断；上层必须当 skipped 处理，不更新 fingerprint。 */
  truncated: boolean;
}

/** safeFetch 的 DI 注入点（生产留空走默认；测试注入桩 + 自定 resolveAll）。 */
export interface SafeFetchOptions {
  /** 域名白名单（默认 checked-in 常量；测试可注入）。 */
  allowlist?: readonly string[] | undefined;
  /** DNS 解析器（默认 node:dns；测试注入桩）。 */
  resolveAll?: ResolveAllFn | undefined;
  /** 预构造的 guarded agents（默认据 resolveAll 现造；复用连接可注入）。 */
  agents?: GuardedAgents | undefined;
  /** 最大重定向跳数（默认 env）。 */
  maxRedirects?: number | undefined;
  /** 超时毫秒（默认 env）。 */
  timeoutMs?: number | undefined;
  /** 响应体上限字节（默认 env）。 */
  maxBytes?: number | undefined;
}

/**
 * 安全 GET：经 SSRF chokepoint + DNS-rebind 闭合 + 每跳重验 + 裸请求（无凭据）。
 *
 * **本入口不接受 headers/token**（design D12）——出站头恰为 `{'User-Agent': env.MR_SCRAPE_USER_AGENT}`。
 * 抛 `SsrfBlockedError`（枚举原因，调用方配 source id 记日志）/超时错。
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const allowlist = options.allowlist ?? MR_SOURCE_DOMAIN_ALLOWLIST;
  const agents = options.agents ?? buildGuardedAgents(options.resolveAll);
  const maxRedirects = options.maxRedirects ?? env.MR_SCRAPE_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? env.MR_SCRAPE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? env.MR_SCRAPE_MAX_RESPONSE_BYTES;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 每跳（含首跳 + 每个重定向目标）重跑 scheme+白名单+字面 IP 守卫（design D10 ⑤）。
    const url = assertUrlAllowed(currentUrl, allowlist);
    const res = await rawGet(url, agents, timeoutMs, maxBytes);

    if (res.status >= 300 && res.status < 400 && res.location) {
      // 解析相对 location 到绝对 URL（下跳重验）。
      currentUrl = new URL(res.location, url).toString();
      continue;
    }
    return {
      status: res.status,
      finalUrl: url.toString(),
      body: res.truncated ? null : res.body,
      truncated: res.truncated,
    };
  }
  // 跳数耗尽仍是 3xx → 拒（禁 redirect:follow 的等价 fail-closed）。
  throw new SsrfBlockedError('too-many-redirects');
}

interface RawGetResult {
  status: number;
  location: string | null;
  body: string;
  truncated: boolean;
}

/**
 * 单跳原生 GET（不跟随重定向）。底层 Agent 的 lookup 做 DNS-rebind 闭合（check==connect）。
 * 固定 UA、无任何其它头；累计体超 maxBytes 即 destroy；硬超时。
 */
function rawGet(
  url: URL,
  agents: GuardedAgents,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawGetResult> {
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const agent = isHttps ? agents.https : agents.http;

  return new Promise<RawGetResult>((resolve, reject) => {
    const req = requestFn(
      url,
      {
        method: 'GET',
        agent,
        // 裸请求：固定 UA，无 Authorization/Cookie/任何 provider key（design D12）。
        headers: { 'User-Agent': env.MR_SCRAPE_USER_AGENT },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location =
          status >= 300 && status < 400
            ? (Array.isArray(res.headers.location)
                ? res.headers.location[0] ?? null
                : res.headers.location ?? null)
            : null;

        // 3xx：不读体（直接判重定向，省带宽）。
        if (location) {
          res.destroy();
          resolve({ status, location, body: '', truncated: false });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = (result: RawGetResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          reject(err);
        };

        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy(); // 超上限立即断（防 OOM/DoS，design D11）。
            console.warn(
              '[mr-scrape:http] response exceeded maxBytes; marked truncated and skipped for fingerprint',
            );
            finish({
              status,
              location: null,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated: true,
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish({
            status,
            location: null,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated: false,
          }),
        );
        res.on('error', fail);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('mr-scrape-timeout'));
    });
    req.end();
  });
}

/**
 * robots.txt 合规检查（design「合规与礼貌」+ D10：robots 取用必走同一 SSRF chokepoint）。
 *
 * 取 `<origin>/robots.txt`（经 `safeFetch` → 第一个触达不可信 host 的请求亦过守卫 + 响应体上限），
 * 解析对**我们 UA（及 `*`）** 的 `Disallow`，判定目标路径是否被禁。**保守**：robots 取用失败/拒绝
 * （SSRF/超时）→ fail-closed 当「禁抓」（绝不在拿不到 robots 时默认放行）。
 *
 * @returns `true` = 允许抓该路径；`false` = robots 禁止或取 robots 失败。
 */
export async function isAllowedByRobots(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }
  const robotsUrl = `${target.origin}/robots.txt`;
  let body: string;
  try {
    const res = await safeFetch(robotsUrl, options);
    if (res.truncated) return false;
    // 404（无 robots）= 无限制，允许；5xx 按抓取失败 fail-closed（skip）。
    if (res.status === 404) return true;
    if (res.status >= 500) return false;
    if (res.status >= 400) return true;
    if (res.body == null) return false;
    body = res.body;
  } catch {
    // robots 取用被 SSRF 守卫拦 / 超时 → fail-closed 当禁抓（robots 重定向私网也落这里）。
    return false;
  }
  return robotsAllows(body, target.pathname, env.MR_SCRAPE_USER_AGENT);
}

/**
 * 纯函数：给定 robots.txt 文本、目标路径、UA，判是否允许。
 * 只取适用于本 UA token 或 `*` 的最具体（最长前缀）`Allow`/`Disallow`，空 `Disallow:` = 允许全部。
 * ponytail: 朴素前缀匹配，不支持 `$`/通配符 robots 扩展；命中典型 `Disallow: /path` 足够（design 合规旋钮）。
 */
export function robotsAllows(robotsTxt: string, path: string, userAgent: string): boolean {
  const uaToken = userAgent.split('/')[0]!.toLowerCase(); // 取 UA 产品名段
  const lines = robotsTxt.split(/\r?\n/);
  // 按 user-agent 分组收集规则。
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const key = (field ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  // 选适用组：精确匹配本 UA token 的组优先，否则全部 `*` 组。合并所有匹配本 bot 的组规则
  // （一个 bot 可声明多个 User-agent 行/多组；RFC 惯例合并而非只取首组）。
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  if (applicable.length === 0) return true; // 无适用规则 = 允许。

  // 最长前缀匹配决定 allow/disallow；等长 tie 优先 Allow（RFC 惯例）。空 path = 不约束。
  let best: { allow: boolean; len: number } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (rule.path === '') continue; // 空 Disallow/Allow = 不约束。
      if (!path.startsWith(rule.path)) continue;
      if (
        !best ||
        rule.path.length > best.len ||
        (rule.path.length === best.len && rule.allow && !best.allow)
      ) {
        best = { allow: rule.allow, len: rule.path.length };
      }
    }
  }
  return best ? best.allow : true;
}

/** 抽「价格/额度区域」归一文本的 per-source extractor 契约（每源一小段正则/切片，不引 cheerio）。 */
export type PriceRegionExtractor = (body: string, sourceUrl: string) => string;

function stripRawTextElement(html: string, tagName: 'script' | 'style'): string {
  const lower = html.toLowerCase();
  const open = `<${tagName}`;
  const close = `</${tagName}>`;
  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) {
      out += html.slice(cursor);
      break;
    }

    const afterOpen = lower[start + open.length];
    if (afterOpen && !/[\s>/]/.test(afterOpen)) {
      out += html.slice(cursor, start + open.length);
      cursor = start + open.length;
      continue;
    }

    out += html.slice(cursor, start);
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) {
      out += ' ';
      break;
    }
    out += ' ';
    cursor = end + close.length;
  }

  return out;
}

/**
 * 默认 extractor（design D7：每源一小段，不引 cheerio）：剥 `<script>`/`<style>`、去标签、压空白、小写归一。
 * per-source 需要更精确切片时在录入侧配专用 extractor 覆盖；默认保「整页价格区域近似」足够指纹检测。
 * ponytail: 全页归一文本，不做 DOM 解析；要 per-source CSS 选择器切片再配 extractor（YAGNI，design D7）。
 */
export const defaultPriceRegionExtractor: PriceRegionExtractor = (body) =>
  // ReDOS 纵深：① 钳输入长度（指纹只需价格区近似，512KB 硬 cap 无害）；
  // ② 标签剥用 `[^<>]`（排除 `<`）+ 有界 `{0,8192}` 使未闭合 `<` 在下一个 `<` 处即失败、不扫到 EOF
  //    （`[^>]` 仍 O(N²)：每个 `<` 回溯整窗；排 `<` 后每位 O(1)，30 万 `<` 由 ~5s 降至 <1ms）。
  //    标签体不含字面 `<`，well-formed 标签照常剥；无 per-job CPU watchdog 故必须本层硬化。
  // ponytail: 超 8192 字符的标签体不被剥、原文计入指纹文本——纯保真度边角（仅 sha256 输入，不渲染/执行/回显），无安全影响。
  stripRawTextElement(stripRawTextElement(body.slice(0, 512_000), 'script'), 'style')
    .replace(/<[^<>]{0,8192}>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
