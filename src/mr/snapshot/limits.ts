/**
 * Model Radar snapshot 层**纯数值额度原语**（design D2，add-model-radar-recommender 组 A）。
 *
 * 这里只放**纯函数**（无 JSX、无 HTTP、无 DB、无 `usageProfile` 等推荐器词汇、绝不 import `src/mr/web/`）——
 * 由比价页 render 层（`src/mr/web/render.ts`）与推荐器（`src/mr/recommend/`）**同消费**，推荐器**不**反向依赖 web 层。
 *
 * - `estimateRounds` + `ESTIMATE_SPREAD` + `DEFAULT_TOKENS_PER_ROUND`：5d-B 估算核心，从 render.ts 下沉至此
 *   （行为等价、render 改 import）。估算结论是 **⚠ 估算**、绝不进快照内容哈希 / 不碰 money-path。
 * - `fitsWindow(limits, demandedRounds, tokensPerRound)`：撞窗判定纯数值原语（design D2）——按 `limitType` 分派、
 *   口径未知不假装、空限额诚实归 `unknown`。`usageProfile`(轻/中/重)→`{demandedRounds,tokensPerRound}` 的映射
 *   是推荐器职责、不在此（两个正交旋钮）。
 */
import type { SnapshotLimit } from './dto.js';

/** 默认每轮 token 假设（保守中等值；可经 query-param 覆盖。ponytail: 物理世界靠这颗旋钮校准，模型看不见真实耗用）。 */
export const DEFAULT_TOKENS_PER_ROUND = 15_000;

/** 区间假设展宽（±50%）：每轮实际耗 token 落在 (1±SPREAD)·假设 内 → 轮次上下界。 */
const ESTIMATE_SPREAD = 0.5;

export interface RoundsEstimate {
  /** 估算依据的限额事实（快照既供，不引新事实）。 */
  basis: { limitType: string; value: string; window: string };
  tokensPerRound: number;
  /** 轮次下界（每轮偏耗）/上界（每轮偏省），向下取整。 */
  low: number;
  high: number;
}

/**
 * 估算中等任务轮次区间（task 5.1 / design D5）：取首个 token 额度限额事实（`monthly_tokens`、`value` 非 null）
 * ÷「每轮 token 假设」→ 区间（±50% 给上下界）。**只在快照既供限额上算、绝不引快照外新事实、绝不进内容哈希**。
 * 无 token 额度 / `value` 为 NULL（不限/占位）/ 旋钮非正 → 返回 null（render 不输出区间，不 NaN、不抛）。
 * ponytail: 只认 `monthly_tokens`——本页 gate 到 coding_plan，credit/fast_pass（Token Plan / 快速通道）非按 token 计，要时再扩。
 */
export function estimateRounds(
  limits: SnapshotLimit[],
  tokensPerRound: number,
): RoundsEstimate | null {
  if (!Number.isFinite(tokensPerRound) || tokensPerRound <= 0) return null;
  const tokenLimit = limits.find((l) => l.limitType === 'monthly_tokens' && l.value !== null);
  if (!tokenLimit || tokenLimit.value === null) return null;
  const total = Number(tokenLimit.value);
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    basis: { limitType: tokenLimit.limitType, value: tokenLimit.value, window: tokenLimit.window },
    tokensPerRound,
    low: Math.floor(total / (tokensPerRound * (1 + ESTIMATE_SPREAD))),
    high: Math.floor(total / (tokensPerRound * (1 - ESTIMATE_SPREAD))),
  };
}

/** 撞窗判定结果：能判则 fits/exceeds，口径未知 / 不能判则 unknown（不假装）。 */
export type FitsWindow = 'fits' | 'exceeds' | 'unknown';

/**
 * 单条限额的撞窗判定（按 `limitType` 分派）。**先判 `limitType`、`none` 在任何 `value===null→unknown` 兜底之前命中**：
 * - `none`（不限）→ `fits`（唯一据 NULL 值报「不撞窗」的合法情形）；
 * - `monthly_tokens` 且 `value` 非 NULL → 经 `estimateRounds` 算 afforded 轮次区间 {low,high} 比 `demandedRounds`：
 *   `≤low`→`fits`、`≥high`→`exceeds`、带内（含估算降级返 null）→`unknown`；
 * - `rolling_5h_requests`/`weekly_messages`（无诚实窗换算）/`credit`/`fast_pass`（口径异构）/真限额 `value:NULL`（占位）→ `unknown`。
 */
function limitFitsWindow(
  limit: SnapshotLimit,
  demandedRounds: number,
  tokensPerRound: number,
): FitsWindow {
  if (limit.limitType === 'none') return 'fits';
  if (limit.limitType === 'monthly_tokens' && limit.value !== null) {
    const est = estimateRounds([limit], tokensPerRound);
    if (!est) return 'unknown'; // 旋钮非正 / 额度非正 → 不能判
    if (demandedRounds <= est.low) return 'fits';
    if (demandedRounds >= est.high) return 'exceeds';
    return 'unknown'; // 落估算带内 → 不假装
  }
  return 'unknown';
}

/**
 * 撞窗判定纯数值原语（design D2）：对 plan 的全部限额事实聚合「最紧」结论。
 * **多限额取最紧**：任一 `exceeds`→`exceeds`；否则任一 `unknown`→`unknown`；全 `fits`→`fits`。
 * **空 `limits[]`（零限额事实）→ `unknown`**（聚合恒等元 = `unknown`，**绝不**因「无 exceeds 无 unknown」而 vacuous 判 `fits`）。
 * 结论是 **⚠ 估算**（非官方事实），调用方须文案明示、绝不进任何哈希/事实。
 */
export function fitsWindow(
  limits: SnapshotLimit[],
  demandedRounds: number,
  tokensPerRound: number,
): FitsWindow {
  if (limits.length === 0) return 'unknown';
  let sawUnknown = false;
  for (const limit of limits) {
    const v = limitFitsWindow(limit, demandedRounds, tokensPerRound);
    if (v === 'exceeds') return 'exceeds'; // 最紧：任一 exceeds 立即定调
    if (v === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'fits';
}
