/**
 * 降级率熔断与系统级故障告警判定（daily-intel-pipeline 10.3，design D8）。
 *
 * 纯函数：不做 I/O、不读时钟，便于单测穷举分支。runDailyWorkflow 用这些判定决定
 * 「是否中止」「是否告警」，但中止/告警的副作用（throw / 调 alert sink）由编排层执行。
 *
 * 关键不变量（绝不可违背，逐字守住 D8）：
 * - 降级率**按阶段分别计算、各自独立熔断**：Value Judge 阶段分母 = 本轮送判（未评分）
 *   事件数；中文摘要阶段分母 = 进入摘要的 Top N 数。禁止合并计算（合并会让摘要的少量
 *   失败被 judge 大分母稀释致熔断失灵）。
 * - 某阶段分母 > 0 且其降级率**严格** `> DEGRADE_ABORT_RATIO` → 该阶段触发熔断。
 * - 分母为 0 时禁止按 0/0 计算（NaN > 阈值 恒假会掩盖问题），且**分母 0 不是错误、不中止**：
 *   shouldAbort 对分母 0 恒返回 false。「judge 分母 = 0」绝不可被误判为「今日无候选」而中止。
 * - 「系统级故障」告警以**采集/规范化层**为准（非 judge 分母）：①采集返回条数 = 0（三源全挂）
 *   或 ②采集返回 > 0 但可处理条目数 = 0（全 unprocessable）→ 告警。可处理数含「塌缩进既有
 *   事件」者，故全命中既有事件的正常无新闻日不告警。
 */

/** 单阶段降级统计：分母（processed）与其中降级条数（degraded）。 */
export interface StageDegrade {
  /** 本阶段实际处理对象数（judge=送判未评分数；digest=Top N 数）。 */
  processed: number;
  /** 其中降级（失败被跳过）的条数。 */
  degraded: number;
}

/**
 * 单阶段熔断判定：分母 > 0 且降级率严格 > ratio 才熔断。
 *
 * 分母 = 0 → 返回 false（不按 0/0 计算、不中止；该阶段本轮无处理对象，流水线继续）。
 *
 * @param stage 本阶段 {processed, degraded}。
 * @param abortRatio 熔断阈值（env.DEGRADE_ABORT_RATIO，如 0.5）。
 */
export function stageShouldAbort(
  stage: StageDegrade,
  abortRatio: number,
): boolean {
  if (stage.processed <= 0) return false; // 分母 0：不算 0/0、不中止。
  const rate = stage.degraded / stage.processed;
  return rate > abortRatio; // 严格大于。
}

/** 单阶段降级率（分母 0 → 返回 null，表示「无可计算」而非 0）。 */
export function stageDegradeRate(stage: StageDegrade): number | null {
  if (stage.processed <= 0) return null;
  return stage.degraded / stage.processed;
}

/** 采集/规范化层统计，用于系统级故障告警判定。 */
export interface CollectStats {
  /** 本轮 collector 返回的条目总数（非「新插入 raw_items 行数」）。 */
  collectedCount: number;
  /**
   * 可处理条目数：能构造 dedup_key、塌缩进 event（含进既有事件）的条目数。
   * = 本轮塌缩中 unprocessable=false 的条数。全命中既有事件时此数 > 0。
   */
  processableCount: number;
}

/** 系统级故障告警判定结果。 */
export interface SystemFailureVerdict {
  /** 是否应告警。 */
  alert: boolean;
  /** 告警类别：三源全挂 / 全 unprocessable / 无（正常）。 */
  kind: 'no-collection' | 'all-unprocessable' | 'none';
  /** 人类可读原因（供 alert sink）。 */
  reason: string | null;
}

/**
 * 系统级故障告警判定（以采集/规范化层为准，非 judge 分母）。
 *
 * - 采集返回条数 = 0（三源全挂）→ alert，kind='no-collection'。
 * - 采集返回 > 0 但可处理条目数 = 0（全 unprocessable，采集器采空/归一函数故障）→
 *   alert，kind='all-unprocessable'。
 * - 采集 > 0 且可处理数 > 0（含全命中既有事件的正常无新闻日）→ 不告警，kind='none'。
 */
export function classifySystemFailure(
  stats: CollectStats,
): SystemFailureVerdict {
  if (stats.collectedCount === 0) {
    return {
      alert: true,
      kind: 'no-collection',
      reason: '本轮采集返回条数为 0（三源全部失败），不静默空跑。',
    };
  }
  if (stats.processableCount === 0) {
    return {
      alert: true,
      kind: 'all-unprocessable',
      reason:
        '本轮采集返回 > 0 但可处理条目数为 0（全部 unprocessable），提示采集器采空或归一函数故障。',
    };
  }
  return { alert: false, kind: 'none', reason: null };
}
