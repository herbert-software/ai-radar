/**
 * Model Radar 比价 Web 页（5d-B，add-model-radar-compare-web-page）的**纯渲染/判定逻辑**（组 B1，task 3.x/4.x/6.x）。
 *
 * 这里只放**纯函数**（无 JSX、无 HTTP、无 DB）——组件（components.tsx）只组装这些函数的输出，组 C 据此单测、
 * 不必 boot server。所有「per-fact age 相对文案」「href scheme 闸」「最划算披露」「新鲜度排序键」都在此，
 * render 层算、**绝不进快照内容哈希 / 不碰 money-path**（最划算/价格排序仍由 queryModelRadarSnapshot 决定，
 * 见 model-radar-page.tsx）。
 */
import type { SnapshotPlan, SnapshotPlanGroup } from '../snapshot/dto.js';
import { DEFAULT_TOKENS_PER_ROUND } from '../snapshot/limits.js';

const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DD` 与 `now` 都截到 **UTC 自然日**算整日差（design D1：相对文案只在 render 层算、不进哈希）。
 * 与 builder 的 `trunc_UTC(last_checked)` 同 TZ 基准，避免跨进程 TZ 误差。
 */
function utcDayDiff(dateStr: string, now: Date): number {
  const date = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - date) / MS_PER_DAY);
}

export interface AgeBadge {
  kind: 'today' | 'days' | 'unchecked';
  /** 文字标签（a11y：状态不靠颜色/emoji 单独承载，见 spec WCAG ③）。 */
  label: string;
  /** 装饰 emoji（渲染时 `aria-hidden`）；待核态无 emoji。 */
  emoji: string;
  days: number | null;
}

/**
 * per-fact age 徽标（task 4.1）：🟢 今日 / 🟡 N 天前 由 `render_now − lastCheckedDate` 算。
 * `lastCheckedDate === null`（仅关联源行可能，从未抓的 browser 源）→「待核 / 从未核对」、**不**显 🟢🟡。
 * 未来日期（时钟偏移）并入「今日」避免出现负数天。
 */
export function ageBadge(lastCheckedDate: string | null, now: Date): AgeBadge {
  if (lastCheckedDate === null) {
    return { kind: 'unchecked', label: '待核 / 从未核对', emoji: '', days: null };
  }
  const days = utcDayDiff(lastCheckedDate, now);
  if (days <= 0) return { kind: 'today', label: '今日核对', emoji: '🟢', days: 0 };
  return { kind: 'days', label: `${days} 天前核对`, emoji: '🟡', days };
}

/**
 * href scheme 闸（task 3.3 / spec「危险 scheme 降级纯文本」/ design D7）：仅放行 `http`/`https`，
 * 否则返回 null（→ 组件降级纯文本，不生成可点 `<a href>`）。`javascript:`/`data:` 等存储型 XSS 向量被拦。
 * 录入侧 `mrSourceUrlSchema` 只拒空白、不校 scheme，故这是公开页的**主防线**。
 */
export function safeHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // 相对/畸形 URL 无法判 scheme → 不渲链接
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // 拒含 userinfo 的 `https://good.com@evil.com`（仍是 http(s) 但诱导误判主机 → 钓鱼），降级纯文本。
  if (parsed.username !== '' || parsed.password !== '') return null;
  return url;
}

/**
 * 取 source_url 的 host 作链接可访问名后缀（task 6.4 / WCAG 2.4.4 链接用途）：避免整页多个同名
 * 「查看来源」无法区分。仅在已过 `safeHref` 的 http(s) URL 上调用；畸形 URL → 空串（调用方退化为无后缀）。
 */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 取 plan 全部 fact 的 lastCheckedDate（价格 + models + clients + limits + 关联源）。仅关联源行可为 null。 */
function planFactDates(plan: SnapshotPlan): (string | null)[] {
  return [
    plan.provenance.lastCheckedDate,
    ...plan.models.map((m) => m.provenance.lastCheckedDate),
    ...plan.clients.map((c) => c.provenance.lastCheckedDate),
    ...plan.limits.map((l) => l.provenance.lastCheckedDate),
    ...plan.sources.map((s) => s.lastCheckedDate),
  ];
}

/**
 * Q4 新鲜度排序键（task 3.4 / design D4）：plan **最旧** fact date。
 * 任一 fact date 为 null（从未抓的关联源）→ 视为**最陈旧**（返回 `''`，字典序排在所有 `YYYY-MM-DD` 之前）。
 * 仅 render 层用、**不入 DTO/哈希、不碰 money-path**。价格/models/clients/limits 的 date 按 DTO 必非 null，
 * 故 nonNull[0]（价格 provenance）必存在。
 */
export function freshnessSortKey(plan: SnapshotPlan): string {
  const dates = planFactDates(plan);
  if (dates.includes(null)) return ''; // null 源 date = 最陈旧
  const nonNull = dates as string[];
  return nonNull.reduce((min, d) => (d < min ? d : min), nonNull[0]!);
}

/** 取 plan 最旧 fact 的 age 徽标（「数据新鲜度」列用）；含 null 源 → 待核徽标。 */
export function oldestFactBadge(plan: SnapshotPlan, now: Date): AgeBadge {
  const key = freshnessSortKey(plan);
  return ageBadge(key === '' ? null : key, now);
}

export type FreshnessSort = 'stale' | 'fresh';

/**
 * 按新鲜度对组内 plans 重排（render 层、不碰 query 的价格排序/分组）：
 * `stale` = 最陈旧优先（freshnessSortKey 升序，null 源最前）；`fresh` = 最新核对优先（降序）。
 * 用方向因子直接排（非 `.reverse()`）→ 稳定排序保同新鲜度键的 plan 维持原有（query 的价/序）相对次序。
 * ponytail: 在 query 既有分组内重排即可——四问的「谁最陈旧」按桶/币种分组内对比已足，跨组全局排名留 v2。
 */
export function sortPlansByFreshness(plans: SnapshotPlan[], dir: FreshnessSort): SnapshotPlan[] {
  const factor = dir === 'fresh' ? -1 : 1;
  return [...plans].sort((a, b) => {
    const ka = freshnessSortKey(a);
    const kb = freshnessSortKey(b);
    if (ka === kb) return 0;
    return (ka < kb ? -1 : 1) * factor;
  });
}

export interface CheapestInfo {
  /** 是否输出「最划算」标：须**已核 plans.length ≥ 2**（仅 `comparable` 对单 plan 已核组也 true，不足判，spec/task 4.2）。 */
  showCheapest: boolean;
  cheapestPlanId: string | null;
  /** 「另有 N 个未核价未参与」的 N（取该 category 的 `currency=null` 组，勿读已核组上的 0，design D4）。 */
  unknownCount: number;
}

/**
 * 最划算披露（task 4.2）。`group` 是 queryModelRadarSnapshot 产出的某已核币种组；`unknownInCategory` 是
 * **跨引**同 category 的 `currency=null` 组的 unknownCount（已核组自身 unknownCount 恒 0，勿读）。
 */
export function cheapestInfo(group: SnapshotPlanGroup, unknownInCategory: number): CheapestInfo {
  const showCheapest = group.plans.length >= 2 && group.cheapestPlanId !== null;
  return {
    showCheapest,
    cheapestPlanId: showCheapest ? group.cheapestPlanId : null,
    unknownCount: unknownInCategory,
  };
}

export interface ModelOption {
  /** 提交值：恒含冒号（`family:version`，version 为空哨兵时为 `family:`）——对齐 query.ts parsedModelSchema。 */
  value: string;
  label: string;
}

export interface FacetOptions {
  models: ModelOption[];
  tools: string[];
  protocols: string[];
}

/**
 * 从（已 gate 到 coding_plan 的）全量 plans 派生筛选下拉选项（task 3.1）。
 * 取**未过滤**的桶2全集，使下拉始终展示所有可选项（与当前筛选无关）。
 * model value 恒含冒号（裸 family 会被 query.ts 判 400）。
 */
export function facetOptions(plans: SnapshotPlan[]): FacetOptions {
  const models = new Map<string, string>(); // value -> label
  const tools = new Set<string>();
  const protocols = new Set<string>();
  for (const p of plans) {
    for (const m of p.models) {
      const value = `${m.family}:${m.version}`;
      models.set(value, m.version === '' ? m.family : value);
    }
    for (const c of p.clients) {
      (c.clientType === 'tool' ? tools : protocols).add(c.clientId);
    }
  }
  return {
    models: [...models.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
    tools: [...tools].sort(),
    protocols: [...protocols].sort(),
  };
}

/**
 * 构造保留当前 query 的链接 query 串（排序链接 / 移除筛选 chip 用）。
 * `current` 只含本页识别的 web 参数；`patch` 值为 null 则删该键。空串值视为缺省（不带 `?model=` 触 400）。
 */
export function withParams(
  current: Record<string, string | undefined>,
  patch: Record<string, string | null>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v != null && v !== '') sp.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) sp.delete(k);
    else sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ───────────────────────── 估算中等任务轮次（组 B2 / task 5.1，design D5）─────────────────────────

/** 旋钮预设「每轮 token 假设」（query-param `tokensPerRound`；原生 `<select>` 选项，无 JS 可调）。 */
export const TOKENS_PER_ROUND_OPTIONS = [
  { value: 5_000, label: '轻量 ≈5k/轮' },
  { value: 15_000, label: '中等 ≈15k/轮' },
  { value: 40_000, label: '重度 ≈40k/轮' },
] as const;

/** 合法旋钮值白名单（= 预设三档；旋钮是 `<select>`，合法值只有这三个）。 */
const TOKENS_PER_ROUND_VALUES = new Set<number>(TOKENS_PER_ROUND_OPTIONS.map((o) => o.value));

/**
 * 解析 query-param `tokensPerRound`（web-only，**不入 .strict() schema / 不进哈希**）。
 * 只认预设三档（白名单）：非预设值（含 crafted `5e-324`/`9999` 等任意有限正数）→ 默认——
 * 既防 `total/极小假设` 算出 Infinity/巨数误导估算，也保证下拉回显与生效值一致。
 * （`estimateRounds`/`DEFAULT_TOKENS_PER_ROUND` 等估算核心已下沉至 `src/mr/snapshot/limits.ts`、render 改 import。）
 */
export function resolveTokensPerRound(raw: string | undefined): number {
  if (raw == null) return DEFAULT_TOKENS_PER_ROUND;
  const n = Number(raw);
  return TOKENS_PER_ROUND_VALUES.has(n) ? n : DEFAULT_TOKENS_PER_ROUND;
}
