/**
 * 规范化纯函数（dedup-and-normalization，design D4）。
 *
 * 两个版本化纯函数 + dedup_key 构造，负责把一条 raw_item 的 url/title
 * 折算成可比较的去重指纹：
 * - `normalizeUrl`   ：生成 canonical_url（去 utm/ref/gclid/fbclid/spm、去 fragment、
 *                      query 排序、host 小写、去尾斜杠）。
 * - `normalizeTitle` ：生成 normalized_title（小写、去标点、去 emoji、去站点名、
 *                      繁简转换、去「快讯/重磅/刚刚」噪声词），并由其 sha256 得 title_hash。
 * - `buildDedupKey`  ：fallback 链 canonical_url → title_hash → unprocessable。
 *
 * 不变量（design D4 / spec）：
 * - 纯函数：同输入恒同输出，无 I/O、无随机、无时钟依赖（除显式传入），便于 P3 回填/重算。
 * - 版本化：每个函数带 `normalizer_version`，规则演进时新旧 hash 不可混比，
 *   版本号写入 raw_items.metadata（写库在 collapse 层 / collector 层做，本模块只产出值）。
 * - 去重判定全程程序 + DB 唯一约束，本模块不含 embedding / LLM。
 */
import { createHash } from 'node:crypto';
import emojiRegex from 'emoji-regex';
import * as OpenCC from 'opencc-js';

/**
 * 规范化规则版本号。
 *
 * 任一规则（URL 参数黑名单、标题噪声词、站点名清单、繁简方向等）变更时**必须**递增，
 * 否则新旧 canonical_url / title_hash 会被误判可比，去重静默失效（最隐蔽的 bug）。
 * 采用单一版本号同时覆盖 URL 与标题两套规则——本期两者总是成对产生与回填，
 * 无需分别版本化；若未来需独立演进再拆分。
 */
export const NORMALIZER_VERSION = 1;

/** 追踪参数黑名单：精确匹配的键。 */
const TRACKING_PARAM_EXACT = new Set([
  'ref',
  'gclid',
  'fbclid',
  'spm',
  'mc_cid',
  'mc_eid',
  'igshid',
  'yclid',
  'msclkid',
  '_hsenc',
  '_hsmi',
]);

/** 追踪参数黑名单：前缀匹配（如 utm_source / utm_medium / utm_* 全族）。 */
const TRACKING_PARAM_PREFIXES = ['utm_'];

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * URL 规范化（生成 canonical_url）。纯函数，带 NORMALIZER_VERSION。
 *
 * 规则（design D4）：
 * - 移除 utm_* / ref / gclid / fbclid / spm 等追踪参数；
 * - 去除 fragment（#...）；
 * - query 参数按键名（同键再按值）排序，使顺序不影响指纹；
 * - host（及协议）小写化；
 * - 去除路径尾部斜杠（根路径 `/` 归一为空）。
 *
 * @returns 规范化后的绝对 URL；输入为空/非法/缺 http(s) 协议 → null（无可用 canonical_url）。
 */
export function normalizeUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // 只接受 http(s)；其余（mailto/javascript/相对等）无意义，视为无 canonical_url。
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  // host 小写（URL 已自动小写 host，这里显式保证）。
  const host = parsed.host.toLowerCase();

  // 过滤追踪参数后按 key、再按 value 稳定排序。
  const params: [string, string][] = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (isTrackingParam(key)) continue;
    params.push([key, value]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const search = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  // 去尾斜杠（保留非根路径的语义，根路径归一为空）。
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.replace(/\/+$/, '');
  }
  if (pathname === '/') pathname = '';

  // fragment 直接丢弃（不拼回）。
  return `${protocol}//${host}${pathname}${search}`;
}

// emoji-regex 每次调用返回新的带 /g 的正则，缓存一个供复用（纯函数语义不受影响）。
const EMOJI_RE = emojiRegex();

// 繁→简转换器（opencc-js）。纯函数：同输入恒同输出。
const toSimplified: OpenCC.ConverterFunction = OpenCC.Converter({ from: 'tw', to: 'cn' });

/**
 * 中文噪声词（去除后不改变事件身份）。
 * 仅作为独立词块剔除，避免误伤正文（如「刚刚好」不应被剔除——这里只在归一串里整体替换，
 * 实际场景标题里这些词常单独出现，权衡后接受极小概率误删）。
 */
const NOISE_WORDS = ['快讯', '重磅', '刚刚', '突发', '独家', '最新', '爆料', '官宣'];

/**
 * 站点名后缀清单（常见「标题 - 站点名」「标题 | 站点名」尾巴）。
 * 归一前先剥离 ` - X` / ` | X` / ` _ X` 形式的尾部站点名。
 */
const SITE_SEPARATORS = ['-', '|', '_', '–', '—', '·', '丨'];

/**
 * 标题归一化（生成 normalized_title）。纯函数，带 NORMALIZER_VERSION。
 *
 * 规则（design D4），顺序经过权衡：
 * 1. 去 emoji（在去标点前，避免 emoji 周围标点残留干扰）；
 * 2. 剥离尾部「分隔符 + 站点名」（如 `... - 36氪`）；
 * 3. 繁→简转换（统一字形）；
 * 4. 小写化（影响拉丁字母）；
 * 5. 去噪声词（快讯/重磅/刚刚 等）；
 * 6. 去标点（保留中英文字母、数字、空白）；
 * 7. 折叠空白并 trim。
 *
 * @returns 归一后的标题串；可能为空串 ''（标题仅由 emoji/标点/噪声词构成）。
 */
export function normalizeTitle(rawTitle: string | null | undefined): string {
  if (!rawTitle) return '';
  let s = rawTitle;

  // 1. 去 emoji。
  s = s.replace(EMOJI_RE, '');

  // 2. 剥离尾部站点名：取最后一个「两侧有空格」的分隔符之后的片段作为候选站点名丢弃。
  //    要求分隔符被空格包裹（如 ` - 36氪`），避免误伤紧贴正文的连字符（GPT-4 / Q-learning / Vol-2）。
  for (const sep of SITE_SEPARATORS) {
    const idx = s.lastIndexOf(` ${sep} `);
    if (idx > 0) {
      const tail = s.slice(idx + 3).trim();
      const head = s.slice(0, idx).trim();
      // 站点名启发式：尾部片段无空格（单一名号）且长度 <= 20，且 head 非空。
      if (head.length > 0 && tail.length > 0 && tail.length <= 20 && !/\s/.test(tail)) {
        s = head;
        break;
      }
    }
  }

  // 3. 繁→简。
  s = toSimplified(s);

  // 4. 小写。
  s = s.toLowerCase();

  // 5. 去噪声词。
  for (const w of NOISE_WORDS) {
    s = s.split(w).join('');
  }

  // 6. 去标点：保留 Unicode 字母（含 CJK）、数字、空白；其余删除。
  //    \p{L} 字母、\p{N} 数字、\s 空白；用 u 标志启用 Unicode 属性转义。
  s = s.replace(/[^\p{L}\p{N}\s]/gu, '');

  // 7. 折叠空白 + trim。
  s = s.replace(/\s+/gu, ' ').trim();

  return s;
}

/** sha256 hex。供 URL / title 指纹复用。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 由原始标题计算 title_hash = sha256(normalized_title)。
 *
 * @returns 归一后非空 → sha256 十六进制串；归一后为空串 → null（无可用 title_hash）。
 */
export function computeTitleHash(rawTitle: string | null | undefined): string | null {
  const normalized = normalizeTitle(rawTitle);
  if (normalized.length === 0) return null;
  return sha256Hex(normalized);
}

/**
 * 规范化产物：一次性算出 canonical_url / title_hash / dedup_key / unprocessable，
 * 并携带版本号供回写 metadata。纯函数（依赖 normalizeUrl/computeTitleHash/buildDedupKey）。
 */
export interface NormalizationResult {
  /** 规范化后的 URL，无则 null。 */
  canonicalUrl: string | null;
  /** sha256(normalized_title)，归一后空串则 null。 */
  titleHash: string | null;
  /** 归一后的标题串（可能为空串），供调试/可观测。 */
  normalizedTitle: string;
  /** 去重冲突键，皆缺则 null。 */
  dedupKey: string | null;
  /** 既无 canonical_url 又无 title_hash → true，不产生 event。 */
  unprocessable: boolean;
  /** 所用规则版本号，写入 raw_items.metadata。 */
  normalizerVersion: number;
}

/**
 * dedup_key 构造与 fallback 链（design D3）：
 * - canonical_url 存在 → sha256(canonical_url)；
 * - 否则 title_hash 存在 → sha256(title_hash)；
 * - 两者皆缺 → null（调用方据此标记 unprocessable，不入 event）。
 *
 * 注意：fallback 第二级是对 title_hash 再做一次 sha256，与第一级保持「dedup_key 始终是
 * 某个指纹的 sha256」的一致语义，并避免 canonical_url 哈希与 title_hash 在同一键空间碰撞。
 */
export function buildDedupKey(
  canonicalUrl: string | null,
  titleHash: string | null,
): string | null {
  if (canonicalUrl) return sha256Hex(canonicalUrl);
  if (titleHash) return sha256Hex(titleHash);
  return null;
}

/**
 * 对一条 raw_item 的 url/title 做完整规范化，产出 canonical_url / title_hash /
 * dedup_key / unprocessable + 版本号。纯函数。
 */
export function normalizeRawItem(input: {
  url?: string | null | undefined;
  title?: string | null | undefined;
}): NormalizationResult {
  const canonicalUrl = normalizeUrl(input.url);
  const normalizedTitle = normalizeTitle(input.title);
  const titleHash = normalizedTitle.length === 0 ? null : sha256Hex(normalizedTitle);
  const dedupKey = buildDedupKey(canonicalUrl, titleHash);
  return {
    canonicalUrl,
    titleHash,
    normalizedTitle,
    dedupKey,
    unprocessable: dedupKey === null,
    normalizerVersion: NORMALIZER_VERSION,
  };
}
