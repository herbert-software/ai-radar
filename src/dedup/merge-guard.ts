/**
 * 合并前确定性精度护栏（harden-semantic-dedup-merge-precision，动机/取舍/已知限制见 design.md）。
 * 抽两侧 `representative_title` 的数字/版本 token 集，不相等即否决合并——挡 embedding 区分不了的
 * 版本/系列/序号/年份变体误合（o1↔o3-mini、GPT-5.3↔5.5 等）。纯确定性、只减少合并、不新增过合并。
 *
 * 两个易被「优化」掉、实则必须的点（防回归）：
 * - **绝不复用 `normalizeTitle`**：其标点剥离把 `3.1`→`31`、删 `#`，毁掉区分 token，故吃原始标题。
 * - 小数作**原子串**（`5.3` 不拆 `5`,`3`）：否则 `GPT-5` 的 `{5}` 会与 `GPT-5.5` 的 `{5.5}` 拆后相等漏判（@0.988 决定性反例）。
 */

/** 抽标题的数字/版本 token 集（小写、小数原子串、去重）。 */
function numericTokens(title: string | null): Set<string> {
  return new Set((title ?? '').toLowerCase().match(/\d+(?:\.\d+)+|\d+/g) ?? []);
}

/**
 * 两标题的数字/版本 token 集不同 → 否决合并（返回 `true`）。
 * 两侧都无数字 → 集相等 → 放行（`false`）；一侧有一侧无 → 否决。
 */
export function shouldVetoMerge(titleA: string | null, titleB: string | null): boolean {
  const a = numericTokens(titleA);
  const b = numericTokens(titleB);
  return a.size !== b.size || [...a].some((t) => !b.has(t));
}
