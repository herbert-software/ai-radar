/**
 * 要闻段↔新品段跨段去重抑制（daily-intel-pipeline 跨段去重，design D3/D4）。
 *
 * 同一项目可经不同源进 `ai_news_events`（要闻）与 `ai_products`（新品）两表（分表去重、无跨表
 * 去重），于是双段重复（生产实锤：HN `48544823` / `grassdx.com` 同时进要闻与新品）。本模块承载
 * **确定性键比对纯函数**：按产品归一三键组（`canonical_domain`/`github_repo`/`product_hunt_slug`）
 * 对齐，任一非空键命中即判同一项目，从要闻段剔除该事件、保留新品段产品。
 *
 * **本模块刻意是纯函数模块（design D4 layering）**：入参为**已提取的键**（事件 `{event, keys}` 列表
 * + 产品三键集合），**自身 MUST NOT import `collectors/*`**——不给 selection 层新增 collectors 依赖边。
 * 键提取（调 `extractProductMergeKeys`）由编排层（run-daily-workflow）做：事件侧从 canonical_url 现提，
 * 产品侧从候选携带的存储三键读（见 product-digest 的候选载体）。
 *
 * 判定 MUST 纯由程序确定性键完成，MUST NOT 调用 LLM / embedding（守第一架构原则：跨表去重由程序
 * 与确定性键保障，绝不交给语义层）。
 */
import type { SelectedEvent } from './top-n.js';

/**
 * 平台 host denylist（**一类缺陷而非两个特例**，design D3 round 2→3）。
 *
 * 背景：产品 `canonical_domain` 语义被重载——真实产品取自 `website` 字段（有意义身份键），但**无
 * website 的 Show HN / PH 等产品**其 raw_item `url` 是提交的**平台 URL**，经 `extractProductMergeKeys`
 * （`website = meta.website ?? input.url`）落成平台 host 域（PH→`producthunt.com`、gitlab 仓库→
 * `gitlab.com`、npm 包→`npmjs.com`…）。`extractProductMergeKeys` **当前只对 `github.com` 置 null**，
 * 其余平台 host 不管。若构建产品域集时不排除这些平台 host，任一 `canonical_url` host 为该平台的要闻
 * 事件会被该域 **mass 误抑制**（与 github.com / producthunt.com 同一类缺陷）。
 *
 * **收录判据**：只收「**URL 路径**（而非**子域**）标识产品」的平台 host——`github.com/owner/repo`、
 * `npmjs.com/package/x`、`producthunt.com/posts/slug`…裸 host 本身不属任一产品、其上路径才是产品身份。
 * **子域标识产品**的 PaaS（`myapp.vercel.app`/`x.github.io`/`x.netlify.app`）**不入**——`extractCanonicalDomain`
 * 取完整 host，`a.github.io ≠ b.github.io`，子域本就是产品唯一身份、不会撞域。
 *
 * **新增产品源（见 `src/collectors/index.ts` 的 `PRODUCT_SOURCES`）若其无 website 兜底 URL 的 host 是
 * 路径式平台 host，MUST 把该 host 加入本常量**——否则该平台 host 的要闻会被 mass 误抑制（须以一次生产
 * 误抑制事故才发现）。`PRODUCT_SOURCES` 定义处有回引注释指向本常量，使两处编辑点都显式化此耦合。
 *
 * **残留（accepted）**：本 denylist 是确定性枚举、不可证完备；未列入的平台 host 仍可能 mass 误抑制
 * 一类该 host 的要闻——后果仅「少推若干要闻、新品段仍在、非数据损坏」，属可接受 bounded 残留。
 */
export const PLATFORM_HOSTS: ReadonlySet<string> = new Set<string>([
  'github.com', // 已被 extractProductMergeKeys 置 null，列入保持判据完整、防其规则变化后漏排。
  'producthunt.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
  'sourceforge.net',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'huggingface.co',
]);

/** 事件侧三键（由 extractProductMergeKeys({ url: canonicalUrl }) 原样提取，事件侧不做平台 host 擦洗）。 */
export interface EventMergeKeys {
  canonicalDomain: string | null;
  githubRepo: string | null;
  productHuntSlug: string | null;
}

/** 待抑制判定的事件 + 其已提取的三键（键提取由编排层完成）。 */
export interface EventWithKeys {
  event: SelectedEvent;
  keys: EventMergeKeys;
}

/**
 * 产品三键集合（全通道候选并集；`domains` 由编排层构建时已剔除 PLATFORM_HOSTS）。
 * `repos`/`slugs` 不剔（github 直链与 PH 走精确键对齐，不存在平台 host 误抑制问题）。
 */
export interface ProductKeySets {
  domains: ReadonlySet<string>;
  repos: ReadonlySet<string>;
  slugs: ReadonlySet<string>;
}

/** 抑制结果：保留的要闻事件 + 被剔事件 id 列表（供日志 / 不写 push_record）。 */
export interface SuppressResult {
  kept: SelectedEvent[];
  suppressedEventIds: string[];
}

/**
 * 跨段去重抑制（确定性纯函数）：事件的**任一非空键**命中产品对应键集合即剔。
 *
 * 命中口径（任一为真即抑制）：
 *   - `canonicalDomain ∈ productKeySets.domains`（产品域集**已排平台 host**，见 PLATFORM_HOSTS）；
 *   - `githubRepo ∈ productKeySets.repos`（闭合 github 直链 news↔product 双段重复）；
 *   - `productHuntSlug ∈ productKeySets.slugs`（事件侧只传 url 时此键恒为 null、对事件不触发，
 *     PH 双段重复属可接受欠抑制，见 daily-intel spec）。
 *
 * **事件侧键不做 PLATFORM_HOSTS 擦洗**：事件键是 extractProductMergeKeys({url}) 原样输出（仅
 * github.com 被该函数置 null），抑制安全性来自**产品域集已排平台 host**——命中需事件域 ∈ 产品域集，
 * 而产品域集不含平台 host，故事件即便域 = producthunt.com 也不会被误抑制。
 *
 * 不修改入参（不可变），返回新数组——保证对同一批输入多次调用结果一致（可单测）。
 *
 * @param eventsWithKeys 待判定要闻事件 + 其已提取三键（入参顺序即保留顺序）。
 * @param productKeySets 全通道产品候选并集三键集合（domains 已排平台 host）。
 */
export function suppressEventsInProducts(
  eventsWithKeys: readonly EventWithKeys[],
  productKeySets: ProductKeySets,
): SuppressResult {
  const kept: SelectedEvent[] = [];
  const suppressedEventIds: string[] = [];

  for (const { event, keys } of eventsWithKeys) {
    const hit =
      (keys.canonicalDomain !== null &&
        productKeySets.domains.has(keys.canonicalDomain)) ||
      (keys.githubRepo !== null && productKeySets.repos.has(keys.githubRepo)) ||
      (keys.productHuntSlug !== null &&
        productKeySets.slugs.has(keys.productHuntSlug));
    if (hit) {
      suppressedEventIds.push(event.eventId);
    } else {
      kept.push(event);
    }
  }

  return { kept, suppressedEventIds };
}
