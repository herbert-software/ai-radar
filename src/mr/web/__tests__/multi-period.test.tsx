/**
 * 组 C 测（add-model-radar-multi-period-web-view / task 3.x）——直测 render.ts 纯函数 +
 * 组件渲染断言（把 `ComparePage` 渲成 HTML 串，**不 boot server**、不触 DB/Redis）。
 *
 * 覆盖：
 * - 3.1 `bestPeriod` 全边界（同币种最低 + 严格更低 + 停售/跨币/无基线抑制 + 并列择 annual + 未取整精确判定）。
 * - 3.2 `periodPriceLine` 折算文案（整除去 `.00` / 非整除保两位 / 未核显待核不折算）。
 * - 3.3 `availabilityBadge` 三值 + `PlanStatusCell` 不把 fresh+已复核的 unknown 吞成「正常」（M2）。
 * - 3.4 组件渲染：月价待核仍渲周期子行、停售行 `.row-discontinued` 无最佳周期徽标、溯源含周期价行、空 periodPrices no-op。
 * - 3.5 money-path 不变：render 层 cheapest 只依 canonical 月价、不受 periodPrices 影响（哈希输入由 cache.test.ts 覆盖）。
 */
import type { Child } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { ComparePage } from '../components.js';
import { availabilityBadge, bestPeriod, cheapestInfo, periodPriceLine } from '../render.js';
import type { SnapshotPlan, SnapshotPlanGroup } from '../../snapshot/dto.js';
import { group, known, periodPrice, unknown } from './fixtures.js';

const NOW = new Date('2026-06-29T00:00:00Z');

/** 把某组 plans 塞进一个已核 (coding_plan, CNY) 组并渲成 HTML 串（不 boot server）。 */
async function renderGroup(plans: SnapshotPlan[], cheapestPlanId: string | null = null): Promise<string> {
  const g = group({ plans, cheapestPlanId });
  return renderGroups([g]);
}

async function renderGroups(groups: SnapshotPlanGroup[], unknownInCategory = 0): Promise<string> {
  const node: Child = (
    <ComparePage
      groups={groups}
      unknownInCategory={unknownInCategory}
      options={{ models: [], tools: [], protocols: [] }}
      query={{}}
      now={NOW}
      tokensPerRound={15_000}
    />
  );
  return `${await node}`;
}

describe('3.1 bestPeriod：同币种已核周期严格低于 canonical 月价才返周期名（单一抑制之家）', () => {
  it('月付最低 → null（周期折算不低于月价）', () => {
    const p = known('P', '30', 'CNY', { periodPrices: [periodPrice('annual', '480', 'CNY', 40)] });
    expect(bestPeriod(p)).toBeNull();
  });

  it('年付折算严格更低 → annual', () => {
    const p = known('P', '100', 'CNY', { periodPrices: [periodPrice('annual', '1080', 'CNY', 90)] });
    expect(bestPeriod(p)).toBe('annual');
  });

  it('季付折算严格更低 → quarterly', () => {
    const p = known('P', '100', 'CNY', { periodPrices: [periodPrice('quarterly', '270', 'CNY', 90)] });
    expect(bestPeriod(p)).toBe('quarterly');
  });

  it('与月价平局（非严格更低）→ null', () => {
    const p = known('P', '100', 'CNY', { periodPrices: [periodPrice('annual', '1200', 'CNY', 100)] });
    expect(bestPeriod(p)).toBeNull();
  });

  it('无同币种已核周期（仅未核周期）→ null', () => {
    const p = known('P', '100', 'CNY', { periodPrices: [periodPrice('quarterly', null, 'CNY', null)] });
    expect(bestPeriod(p)).toBeNull();
  });

  it('月价 unknown（无合法基线）→ null（即便有更低已核周期）', () => {
    const p = unknown('P', { periodPrices: [periodPrice('annual', '600', 'CNY', 50)] });
    expect(bestPeriod(p)).toBeNull();
  });

  it('停售 → null（停售抑制在 bestPeriod 内、组件层不重复）', () => {
    const p = known('P', '100', 'CNY', {
      availability: 'discontinued',
      periodPrices: [periodPrice('annual', '1080', 'CNY', 90)],
    });
    expect(bestPeriod(p)).toBeNull();
  });

  it('异币种周期（数值更低）→ null（不跨币 FX）', () => {
    // 月价 CNY 100；USD 年付折算数值 50 < 100，但币种不同 → 不参与最佳周期比较。
    const p = known('P', '100', 'CNY', { periodPrices: [periodPrice('annual', '600', 'USD', 50)] });
    expect(bestPeriod(p)).toBeNull();
  });

  it('同币种季/年并列最低且均严格更低 → 确定性择 annual（更长承诺）', () => {
    const p = known('P', '100', 'CNY', {
      periodPrices: [periodPrice('quarterly', '270', 'CNY', 90), periodPrice('annual', '1080', 'CNY', 90)],
    });
    expect(bestPeriod(p)).toBe('annual');
    // 迭代序无关：交换顺序仍为 annual。
    const swapped = known('P', '100', 'CNY', {
      periodPrices: [periodPrice('annual', '1080', 'CNY', 90), periodPrice('quarterly', '270', 'CNY', 90)],
    });
    expect(bestPeriod(swapped)).toBe('annual');
  });

  it('用未取整精确值判定：精确 33.3299 严格低于基线 33.33 → annual（展示两值都看似 33.33）', () => {
    const p = known('P', '33.33', 'CNY', { periodPrices: [periodPrice('annual', '399.95', 'CNY', 399.95 / 12)] });
    expect(bestPeriod(p)).toBe('annual');
    expect(periodPriceLine(p.periodPrices[0]!)).toContain('≈CNY 33.33/月'); // 展示取整到 33.33，与基线看似相等
  });
});

describe('3.2 periodPriceLine：已核显原始价 + 折算（取整去末尾 0）、未核显待核不折算', () => {
  it('非整除 1099/12 → 折算保两位 91.58', () => {
    const line = periodPriceLine(periodPrice('annual', '1099', 'CNY', 1099 / 12));
    expect(line).toBe('年付 CNY 1099（≈CNY 91.58/月）');
  });

  it('整除 948/12 → 折算显 79（不带 .00）', () => {
    const line = periodPriceLine(periodPrice('annual', '948', 'CNY', 948 / 12));
    expect(line).toBe('年付 CNY 948（≈CNY 79/月）');
    expect(line).not.toContain('79.00');
  });

  it('未核周期 → 「季付 待核」，无折算月价数字', () => {
    const line = periodPriceLine(periodPrice('quarterly', null, 'CNY', null));
    expect(line).toBe('季付 待核');
    expect(line).not.toContain('≈');
    expect(line).not.toContain('/月');
  });
});

describe('3.3 availabilityBadge 三值 + PlanStatusCell 不吞 unknown（M2）', () => {
  it('discontinued → 已停售 / unknown → 状态未知 / on_sale → 无标（null）', () => {
    expect(availabilityBadge('discontinued')).toMatchObject({ kind: 'discontinued', label: '已停售' });
    expect(availabilityBadge('unknown')).toMatchObject({ kind: 'unknown', label: '状态未知' });
    expect(availabilityBadge('on_sale')).toBeNull();
  });

  it('fresh+已复核的 unknown 行仍出「状态未知」、不被「正常」提前返回吞掉', async () => {
    // known() 默认 availability='unknown'、stale=false、pending=false → 命中「!stale && !pending」提前返回条件。
    const html = await renderGroup([known('U', '30', 'CNY', { availability: 'unknown' })]);
    expect(html).toContain('状态未知');
    expect(html).not.toContain('正常'); // availability 先于/独立于「正常」求值
  });

  it('on_sale + fresh + 已复核 → 显「正常」、不出任何 availability 标', async () => {
    const html = await renderGroup([known('N', '30', 'CNY', { availability: 'on_sale' })]);
    expect(html).toContain('正常');
    expect(html).not.toContain('状态未知');
    expect(html).not.toContain('已停售');
  });
});

describe('3.4 组件渲染（不 boot server）：拆段 / 停售抑制 / 溯源周期行 / 空 periodPrices no-op', () => {
  it('月价待核 + 年付已核 → 月价段显待核、年付子行仍照实渲（原始价 + 折算）', async () => {
    const p = unknown('X', { periodPrices: [periodPrice('annual', '1080', 'CNY', 90)] });
    const html = await renderGroup([p]);
    expect(html).toContain('待核'); // 月价段
    expect(html).toContain('period-price'); // 周期子行渲出
    expect(html).toContain('年付 CNY 1080（≈CNY 90/月）'); // 月价待核不遮蔽已核周期价
  });

  it('周期真省钱 → 挂「最佳周期 · 年付」徽标、不报省额', async () => {
    const p = known('B', '100', 'CNY', { periodPrices: [periodPrice('annual', '1080', 'CNY', 90)] });
    const html = await renderGroup([p]);
    expect(html).toContain('badge-best-period');
    expect(html).toContain('最佳周期 · 年付');
  });

  it('跨币同周期：徽标只挂同币种(CNY)年付子行，异币种(USD)同周期子行不误标（F1 守卫）', async () => {
    // schema 允许 UNIQUE(plan_id, billing_period, currency)：同 plan 可有同周期两币种行。
    // bestPeriod 只比同币种 → winner 唯一是 (annual, CNY)；徽标须同样受同币种约束。
    const p = known('B', '100', 'CNY', {
      periodPrices: [periodPrice('annual', '1080', 'CNY', 90), periodPrice('annual', '600', 'USD', 50)],
    });
    const html = await renderGroup([p]);
    // 徽标唯一：只挂 winner 的同币种子行（若回退 F1，异币种同周期子行也被误标 → 2 个）。
    expect(html.match(/badge-best-period/g)?.length).toBe(1);
    // 异币种(USD)年付子行片段内不得含最佳周期徽标（先锚定该行确已渲染，否则 indexOf=-1 会让负断言空过）。
    const usdStart = html.indexOf('年付 USD 600');
    expect(usdStart).toBeGreaterThanOrEqual(0);
    const usdSegment = html.slice(usdStart).split('period-price')[0]!;
    expect(usdSegment).not.toContain('badge-best-period');
    // 同币种(CNY)年付子行片段内确实挂了徽标。
    const cnyStart = html.indexOf('年付 CNY 1080');
    expect(cnyStart).toBeGreaterThanOrEqual(0);
    const cnySegment = html.slice(cnyStart).split('period-price')[0]!;
    expect(cnySegment).toContain('badge-best-period');
  });

  it('停售行有 .row-discontinued + 月价删除线 + 无最佳周期徽标', async () => {
    const p = known('D', '100', 'CNY', {
      availability: 'discontinued',
      periodPrices: [periodPrice('annual', '1080', 'CNY', 90)],
    });
    const html = await renderGroup([p]);
    expect(html).toContain('row-discontinued');
    expect(html).toContain('price-struck');
    expect(html).toContain('已停售');
    expect(html).not.toContain('badge-best-period'); // 停售抑制（bestPeriod 返 null）
    expect(html).toContain('年付 CNY 1080'); // 停售仍可看周期价（可看不可买）
  });

  it('溯源展开区含独立「年付价」provenance 行', async () => {
    const p = known('S', '100', 'CNY', { periodPrices: [periodPrice('annual', '1080', 'CNY', 90)] });
    const html = await renderGroup([p]);
    expect(html).toContain('年付价'); // ProvenanceLine label
  });

  it('空 periodPrices（现有主流 plan）→ 不渲周期子行、月价路径与现状一致（no-op 回归）', async () => {
    const html = await renderGroup([known('M', '30', 'CNY')]);
    expect(html).toContain('CNY 30'); // 月价照旧
    expect(html).not.toContain('period-price'); // 无周期子行
    expect(html).not.toContain('badge-best-period'); // 无最佳周期
    expect(html).not.toContain('待核'); // 月价已核、无未核周期占位
  });
});

describe('3.5 money-path 不变：render 层 cheapest 只依 canonical 月价、不受 periodPrices 影响（F7）', () => {
  it('cheapestInfo 透传 query 的 cheapestPlanId，periodPrices 折算再低也不改（纯函数）', () => {
    // A 月价 100 但塞入折算月价 1 的年付；B 月价 40 由 query 定为 cheapest。render 层不得据周期价改判。
    const a = known('A', '100', 'CNY', { periodPrices: [periodPrice('annual', '12', 'CNY', 1)] });
    const b = known('B', '40', 'CNY');
    const g = group({ plans: [a, b], cheapestPlanId: 'B' });
    expect(cheapestInfo(g, 0).cheapestPlanId).toBe('B'); // 仍按月价，不被 A 的超低周期折算撬动
  });

  it('渲染下「最划算」徽标落在月价最低者，即便他人有更低折算周期', async () => {
    const a = known('A', '100', 'CNY', { periodPrices: [periodPrice('annual', '12', 'CNY', 1)] });
    const b = known('B', '40', 'CNY');
    const html = await renderGroup([a, b], 'B'); // query 定 cheapest=B（月价 40 最低）
    expect(html).toContain('最划算：B');
    expect(html).toContain('badge-best-period'); // A 的年付仍标最佳周期
    // 最佳周期与最划算正交：A 有最佳周期徽标却非最划算。
    expect(html).not.toContain('最划算：A');
  });

  // 快照内容哈希输入不变：periodPrices/effectiveMonthly 作为 DTO 字段已由既有快照契约纳入哈希，
  // 本 render-only 变更不新增哈希输入——该守卫由 src/mr/snapshot/__tests__/cache.test.ts 覆盖，此处不重复。
});
