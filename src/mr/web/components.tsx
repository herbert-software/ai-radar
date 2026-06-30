/**
 * Model Radar 比价 Web 页（5d-B，组 B1）的 `hono/jsx` 组件（task 2.4 / 3.x / 4.x / 6.x）。
 *
 * 组件**只组装** render.ts 的纯函数输出 + 快照 DTO 字段——判定逻辑全在 render.ts（组 C 单测）。
 * a11y 基线（design D8 / spec「WCAG 2.2 AA」）：原生 `<table>/<caption>/<th scope>` + `<details>/<summary>`，
 * 徽标含文字标签（emoji `aria-hidden`），地标 + skip-link + `lang` + 描述性 `<title>`。
 * XSS（design D7）：所有快照串经 `hono/jsx` 默认转义；**无 `raw()`/`dangerouslySetInnerHTML`**；
 * `source_url` 经 `safeHref` gate scheme，否则降级纯文本。
 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { mrCurrencySchema } from '../../db/mr-schema.zod.js';
import type { SnapshotPlan, SnapshotPlanGroup, SnapshotProvenance } from '../snapshot/dto.js';
import { estimateRounds } from '../snapshot/limits.js';
import {
  ageBadge,
  cheapestInfo,
  oldestFactBadge,
  resolveTokensPerRound,
  safeHref,
  sortPlansByFreshness,
  sourceHost,
  withParams,
  TOKENS_PER_ROUND_OPTIONS,
  type AgeBadge,
  type FacetOptions,
  type FreshnessSort,
} from './render.js';

/** 本页识别的 web query 参数（透传给排序链接 / 移除 chip；估算旋钮等 B2 参数不在此）。 */
export interface WebQuery {
  model?: string;
  tool?: string;
  protocol?: string;
  currency?: string;
  maxMonthlyPrice?: string;
  sort?: string;
  /** 估算旋钮（web-only query-param，不入 .strict() schema / 不进哈希；render 层用，task 5.x）。 */
  tokensPerRound?: string;
}

/** a11y CSS（内联 `<style>`，CSP `style-src 'self' 'unsafe-inline'` 容之；对比 ≥4.5:1、可见焦点环、目标尺寸基线）。 */
const PAGE_CSS = `
  :root { color-scheme: light; }                     /* 仅定义浅色调色板，避免 UA 暗色翻原生控件叠白底页 */
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #fff; }
  a { color: #0b4fb3; }
  a:focus-visible, button:focus-visible, summary:focus-visible, select:focus-visible,
  input:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid #0b4fb3; outline-offset: 2px;
  }
  .skip-link { position: absolute; left: -9999px; top: 0; background: #0b4fb3; color: #fff; padding: .5rem 1rem; z-index: 10; }
  .skip-link:focus { left: 0; }
  header, nav, main { padding: 1rem; }
  header { border-bottom: 1px solid #ccc; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .muted { color: #595959; }                         /* 次级灰仍 ≥4.5:1 */
  form.filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; margin: 0 0 1rem; }
  form.filters label { display: flex; flex-direction: column; font-size: .85rem; gap: .25rem; }
  form.filters select, form.filters input { min-height: 28px; padding: .25rem; font-size: 1rem; }
  form.filters button { min-height: 28px; padding: .4rem 1rem; }
  .chips { list-style: none; display: flex; flex-wrap: wrap; gap: .5rem; padding: 0; margin: .5rem 0; }
  .chip { display: inline-flex; align-items: center; gap: .35rem; min-height: 24px;
    padding: .2rem .6rem; border: 1px solid #0b4fb3; border-radius: 999px; text-decoration: none; }
  .chip[aria-current="true"] { background: #e7f0fb; }
  /* Reflow（1.4.10/1.4.4）：表裹横向滚动容器，320px 宽 / 400% 缩放下单向滚动、不双向、不丢内容；行/列头关联保留。 */
  .table-scroll { overflow-x: auto; max-width: 100%; margin: 0 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; min-width: 720px; margin: 0; }
  caption { text-align: left; font-weight: 600; padding: .5rem 0; }
  th, td { border: 1px solid #ccc; padding: .4rem .5rem; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  th[scope="row"] { position: sticky; left: 0; }     /* 横向滚动时套餐名留可见（reflow UX，#f2f2f2 不透明不透叠） */
  .badge { display: inline-flex; align-items: center; gap: .25rem; font-size: .8rem;
    padding: .05rem .4rem; border-radius: 4px; white-space: nowrap; }
  .badge-cheap { background: #d6f5d6; color: #134a13; font-weight: 600; }
  .badge-stale { background: #fde2e2; color: #8a1c1c; }
  .badge-review { background: #fff0d6; color: #7a4a00; }
  .age-today { color: #134a13; }
  .age-days { color: #7a4a00; }
  .age-unchecked, .unchecked { color: #595959; font-style: italic; }
  summary { min-height: 24px; cursor: pointer; }
  details ul { margin: .25rem 0; padding-left: 1.1rem; }
  /* 目标尺寸（2.5.8）：排序控件独立点击区 ≥24px（旋钮用 <select>，已 28px）。 */
  .sort-link { display: inline-block; min-height: 24px; padding: .15rem .4rem; }
  /* 估算轮次：视觉次于官方额度（小字次级色），文字承载「⚠ 估算」（task 5.2）。 */
  .estimate { margin: .35rem 0 0; font-size: .8rem; color: #595959; }
  .estimate-note { color: #6b6b6b; }
  .badge-estimate { background: #fff0d6; color: #7a4a00; font-weight: 600; }
`;

/** 装饰 emoji + 文字标签的徽标（emoji `aria-hidden`，状态由文字承载，spec WCAG ③）。 */
const AgeBadgeView: FC<{ badge: AgeBadge }> = ({ badge }) => {
  const cls = badge.kind === 'today' ? 'age-today' : badge.kind === 'days' ? 'age-days' : 'age-unchecked';
  return (
    <span class={`badge ${cls}`}>
      {badge.emoji !== '' && <span aria-hidden="true">{badge.emoji}</span>}
      {badge.label}
    </span>
  );
};

/**
 * 估算中等任务轮次区间（task 5.1/5.2）：从快照既供限额事实算、视觉次于官方额度（小字次级色）、文字标「⚠ 估算」。
 * `limit.value` 为 NULL / 无 token 额度 / 旋钮非正 → `estimateRounds` 返 null → 不输出区间（优雅降级、不 NPE）。
 */
const EstimatedRounds: FC<{ plan: SnapshotPlan; tokensPerRound: number }> = ({ plan, tokensPerRound }) => {
  const est = estimateRounds(plan.limits, tokensPerRound);
  if (!est) return null;
  return (
    <p class="estimate">
      <span class="badge badge-estimate">
        <span aria-hidden="true">⚠</span>估算
      </span>{' '}
      约 {est.low}–{est.high} 轮中等任务
      <span class="estimate-note">（假设每轮 {est.tokensPerRound} tokens，非官方事实）</span>
    </p>
  );
};

/** 页面外壳：lang/title/地标/skip-link/内联样式（task 6.3）。 */
export const PageShell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="zh-Hans">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{PAGE_CSS}</style>
    </head>
    <body>
      <a class="skip-link" href="#main">
        跳到主内容
      </a>
      <header>
        <h1>Model Radar 比价 · Coding Plan</h1>
        <p class="muted">
          只读快照渲染。价格 / 兼容 / 额度为精确事实，逐格可溯源；新鲜度按各事实最近核对日呈现。
        </p>
      </header>
      <nav aria-label="页面导航">
        <a href="/model-radar">比价首页（清除筛选）</a>
      </nav>
      <main id="main">{children}</main>
    </body>
  </html>
);

/** 已选筛选 chip（aria-current 标已选态 + 移除链接，键盘可清除；task 6.2）。 */
const ActiveFilterChips: FC<{ query: WebQuery }> = ({ query }) => {
  const items: { key: keyof WebQuery; label: string }[] = [];
  if (query.model) items.push({ key: 'model', label: `模型 ${query.model}` });
  if (query.tool) items.push({ key: 'tool', label: `工具 ${query.tool}` });
  if (query.protocol) items.push({ key: 'protocol', label: `协议 ${query.protocol}` });
  if (query.currency) items.push({ key: 'currency', label: `币种 ${query.currency}` });
  if (query.maxMonthlyPrice) items.push({ key: 'maxMonthlyPrice', label: `预算 ${query.maxMonthlyPrice}` });
  if (items.length === 0) return null;
  return (
    <ul class="chips" aria-label="已应用的筛选">
      {items.map((it) => (
        <li>
          <a
            class="chip"
            aria-current="true"
            href={withParams(query as Record<string, string | undefined>, { [it.key]: null })}
            aria-label={`移除筛选：${it.label}`}
          >
            <span aria-hidden="true">×</span>
            {it.label}
          </a>
        </li>
      ))}
    </ul>
  );
};

/** 筛选表单（GET、渐进增强、无 JS 可用；选项预选用原生 `selected`，task 3.1）。 */
export const FilterForm: FC<{ options: FacetOptions; query: WebQuery }> = ({ options, query }) => (
  <form class="filters" method="get" role="search" aria-label="筛选 Coding Plan">
    <label>
      模型
      <select name="model">
        <option value="" selected={!query.model}>
          全部模型
        </option>
        {options.models.map((m) => (
          <option value={m.value} selected={query.model === m.value}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
    <label>
      工具
      <select name="tool">
        <option value="" selected={!query.tool}>
          全部工具
        </option>
        {options.tools.map((t) => (
          <option value={t} selected={query.tool === t}>
            {t}
          </option>
        ))}
      </select>
    </label>
    <label>
      协议
      <select name="protocol">
        <option value="" selected={!query.protocol}>
          全部协议
        </option>
        {options.protocols.map((p) => (
          <option value={p} selected={query.protocol === p}>
            {p}
          </option>
        ))}
      </select>
    </label>
    <label>
      币种
      <select name="currency">
        <option value="" selected={!query.currency}>
          全部币种
        </option>
        {mrCurrencySchema.options.map((c) => (
          <option value={c} selected={query.currency === c}>
            {c}
          </option>
        ))}
      </select>
    </label>
    <label>
      预算上限
      <input
        type="text"
        name="maxMonthlyPrice"
        value={query.maxMonthlyPrice ?? ''}
        placeholder="如 100 CNY"
        inputmode="text"
      />
    </label>
    <label>
      每轮 token 假设（估算用）
      <select name="tokensPerRound">
        {TOKENS_PER_ROUND_OPTIONS.map((opt) => (
          <option value={String(opt.value)} selected={resolveTokensPerRound(query.tokensPerRound) === opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
    {/* 透传当前排序，使提交筛选不丢失新鲜度排序 */}
    {query.sort ? <input type="hidden" name="sort" value={query.sort} /> : null}
    <button type="submit">应用筛选</button>
    <a class="chip" href="/model-radar">
      重置
    </a>
  </form>
);

/**
 * source_url 链接——**全页唯一 `safeHref` 渲染点**（单一 XSS 闸，易审计）：
 * 经 scheme 闸过则渲可点 `<a>`，危险/畸形 scheme（javascript:/data: 等）降级纯文本（design D7）。
 */
const SourceLink: FC<{ url: string }> = ({ url }) => {
  const href = safeHref(url);
  return href ? (
    <a href={href} rel="noopener noreferrer">
      查看来源（{sourceHost(href)}）
    </a>
  ) : (
    <span class="muted">来源（不可链接）：{url}</span>
  );
};

/** 单条事实 provenance 行（source 链接 + age 徽标 + confidence）。 */
const ProvenanceLine: FC<{ label: string; prov: SnapshotProvenance; now: Date }> = ({ label, prov, now }) => (
  <li>
    <strong>{label}</strong>：{' '}
    <SourceLink url={prov.sourceUrl} />{' '}
    <span class="muted">置信度 {prov.sourceConfidence}</span>{' '}
    <AgeBadgeView badge={ageBadge(prov.lastCheckedDate, now)} />
  </li>
);

/** 行展开溯源：每条价/兼容/额度事实 + 关联源的 provenance（原生 `<details>`，无 JS 可用，task 3.3/6.2）。 */
const ProvenanceDetails: FC<{ plan: SnapshotPlan; now: Date }> = ({ plan, now }) => (
  <details>
    <summary>溯源</summary>
    <ul>
      <ProvenanceLine label="价格" prov={plan.provenance} now={now} />
      {plan.models.map((m) => (
        <ProvenanceLine label={`模型 ${modelLabel(m.family, m.version)}`} prov={m.provenance} now={now} />
      ))}
      {plan.clients.map((c) => (
        <ProvenanceLine label={`${c.clientType === 'tool' ? '工具' : '协议'} ${c.clientId}`} prov={c.provenance} now={now} />
      ))}
      {plan.limits.map((l) => (
        <ProvenanceLine label={`额度 ${l.limitType}`} prov={l.provenance} now={now} />
      ))}
      {plan.sources.map((s) => (
        <li>
          <strong>关联源（{s.fetchStrategy}）</strong>：{' '}
          <SourceLink url={s.sourceUrl} />{' '}
          <AgeBadgeView badge={ageBadge(s.lastCheckedDate, now)} />
        </li>
      ))}
    </ul>
  </details>
);

/** 价格格：已核 → 币种+价（不 format，防 NPE）+ 最划算标 + age；未核 → 「待核」占位（task 3.2/4.2）。 */
const PriceCell: FC<{ plan: SnapshotPlan; now: Date; isCheapest: boolean }> = ({ plan, now, isCheapest }) => {
  if (plan.priceStatus === 'known' && plan.currentPrice !== null && plan.currency !== null) {
    return (
      <td>
        <span>
          {plan.currency} {plan.currentPrice}
        </span>
        {isCheapest ? (
          <>
            {' '}
            <span class="badge badge-cheap">
              <span aria-hidden="true">⭐</span>最划算
            </span>
          </>
        ) : null}
        <br />
        <AgeBadgeView badge={ageBadge(plan.provenance.lastCheckedDate, now)} />
      </td>
    );
  }
  return (
    <td>
      <span class="unchecked">待核</span>
    </td>
  );
};

/** plan 级状态徽标：🔴 待复核 / 陈旧（freshness.stale + reviewStatus.pending 聚合，禁冒充 per-cell，task 4.1）。 */
const PlanStatusCell: FC<{ plan: SnapshotPlan }> = ({ plan }) => {
  if (!plan.freshness.stale && !plan.reviewStatus.pending) {
    return (
      <td>
        <span class="muted">正常</span>
      </td>
    );
  }
  return (
    <td>
      {plan.reviewStatus.pending ? (
        <span class="badge badge-review">
          <span aria-hidden="true">🔴</span>待复核
        </span>
      ) : null}{' '}
      {plan.freshness.stale ? (
        <span class="badge badge-stale">
          <span aria-hidden="true">🟠</span>陈旧
        </span>
      ) : null}
    </td>
  );
};

function modelLabel(family: string, version: string): string {
  return version === '' ? family : `${family}:${version}`;
}

/** 排序方向链接（方向性可访问名，task 6.1）。 */
const SortLinks: FC<{ query: WebQuery; kind: 'price' | 'fresh' }> = ({ query, kind }) => {
  const q = query as Record<string, string | undefined>;
  if (kind === 'price') {
    return (
      <a class="sort-link" href={withParams(q, { sort: null })} aria-label="按价格升序排序">
        价格升序
      </a>
    );
  }
  return (
    <>
      <a class="sort-link" href={withParams(q, { sort: 'stale' })} aria-label="按数据新鲜度排序，最陈旧优先">
        最陈旧优先
      </a>{' '}
      <a class="sort-link" href={withParams(q, { sort: 'fresh' })} aria-label="按数据新鲜度排序，最新核对优先">
        最新优先
      </a>
    </>
  );
};

/** 单个 (category,currency) 组的比价表（原生 table + caption + th scope + aria-sort，task 6.1）。 */
const GroupTable: FC<{
  group: SnapshotPlanGroup;
  unknownInCategory: number;
  query: WebQuery;
  sort?: FreshnessSort;
  now: Date;
  tokensPerRound: number;
}> = ({ group, unknownInCategory, query, sort, now, tokensPerRound }) => {
  const known = group.sortScope.currency !== null;
  const info = cheapestInfo(group, unknownInCategory);
  const plans = sort ? sortPlansByFreshness(group.plans, sort) : group.plans;
  const cheapestName = info.cheapestPlanId
    ? group.plans.find((p) => p.id === info.cheapestPlanId)?.name
    : undefined;

  const caption = known ? (
    <>
      Coding Plan · {group.sortScope.currency} ·{' '}
      {info.showCheapest ? (
        <span>
          最划算：{cheapestName}（已核价中最低）
          {info.unknownCount > 0 ? <span class="muted">；另有 {info.unknownCount} 个未核价未参与</span> : null}
        </span>
      ) : (
        <span class="muted">
          已核价不足 2，暂不评最划算
          {info.unknownCount > 0 ? <span>（{info.unknownCount} 个待核）</span> : null}
        </span>
      )}
    </>
  ) : (
    <>
      Coding Plan · 未核价 ·{' '}
      <span class="muted">暂不参与最划算比较（{group.plans.length} 项待核）</span>
    </>
  );

  // aria-sort：仅已核组默认价格升序（query 保证同币种组价升序）；未核组无意义价序 / freshness 排序时 → none。
  const priceSort = !known || sort ? 'none' : 'ascending';
  const freshSort = sort === 'stale' ? 'ascending' : sort === 'fresh' ? 'descending' : 'none';
  const scopeLabel = known ? `Coding Plan ${group.sortScope.currency}` : 'Coding Plan 未核价';

  return (
    <div class="table-scroll" role="group" tabindex={0} aria-label={`比价表：${scopeLabel}（可横向滚动）`}>
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">套餐</th>
          <th scope="col">厂商</th>
          <th scope="col" aria-sort={priceSort}>
            价格 <SortLinks query={query} kind="price" />
          </th>
          <th scope="col">模型</th>
          <th scope="col">工具 / 协议</th>
          <th scope="col">额度</th>
          <th scope="col" aria-sort={freshSort}>
            数据新鲜度 <SortLinks query={query} kind="fresh" />
          </th>
          <th scope="col">状态</th>
          <th scope="col">溯源</th>
        </tr>
      </thead>
      <tbody>
        {plans.map((p) => (
          <tr>
            <th scope="row">{p.name}</th>
            <td>{p.vendorName}</td>
            <PriceCell plan={p} now={now} isCheapest={info.showCheapest && p.id === info.cheapestPlanId} />
            <td>
              {p.models.length === 0 ? (
                <span class="muted">—</span>
              ) : (
                p.models.map((m) => <div>{modelLabel(m.family, m.version)}</div>)
              )}
            </td>
            <td>
              {p.clients.length === 0 ? (
                <span class="muted">—</span>
              ) : (
                p.clients.map((c) => (
                  <div>
                    {c.clientType === 'tool' ? '工具' : '协议'}：{c.clientId}
                  </div>
                ))
              )}
            </td>
            <td>
              {p.limits.length === 0 ? (
                <span class="muted">—</span>
              ) : (
                p.limits.map((l) => (
                  <div>
                    {l.limitType}：{l.value ?? '不限 / 待定'} / {l.window}
                  </div>
                ))
              )}
              <EstimatedRounds plan={p} tokensPerRound={tokensPerRound} />
            </td>
            <td>
              <AgeBadgeView badge={oldestFactBadge(p, now)} />
            </td>
            <PlanStatusCell plan={p} />
            <td>
              <ProvenanceDetails plan={p} now={now} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
};

/** 比价页主体：筛选 + 已选 chip + 各组表（task 2.4）。 */
export const ComparePage: FC<{
  groups: SnapshotPlanGroup[];
  unknownInCategory: number;
  options: FacetOptions;
  query: WebQuery;
  sort?: FreshnessSort;
  now: Date;
  tokensPerRound: number;
}> = ({ groups, unknownInCategory, options, query, sort, now, tokensPerRound }) => (
  <>
    <FilterForm options={options} query={query} />
    <ActiveFilterChips query={query} />
    {groups.length === 0 ? (
      <p>无匹配 Coding Plan 套餐。可调整或重置筛选。</p>
    ) : (
      groups.map((g) => (
        <GroupTable
          group={g}
          unknownInCategory={unknownInCategory}
          query={query}
          {...(sort ? { sort } : {})}
          now={now}
          tokensPerRound={tokensPerRound}
        />
      ))
    )}
  </>
);
