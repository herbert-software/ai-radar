/**
 * arXiv OAI-PMH 增量游标存储（at-least-once 接线，source-collectors / design D3）。
 *
 * 本期为 arXiv 增量采集选**最简且 crash-safe 无漏窗**方案：**固定回溯窗口（option ①）**。
 *
 * 设计要点（为何无需新建表、无需持久化游标）：
 * - `load()` 恒返回 `now - LOOKBACK_DAYS`（保守 7 天），作 OAI-PMH 的 `from` 参数——每轮都**重抓
 *   整个回溯窗口**而非「从上次某一点继续」。
 * - `commit(to)` 是 **no-op**：固定窗口方案不持久化任何游标，无「先推进后入库会漏窗」之虞。
 *
 * at-least-once 由「固定窗口 + UNIQUE(source, source_item_id)」共同保障，**不依赖持久化游标**：
 * - **无漏窗**：每轮 `from = now - 7d` 覆盖近 7 天全部上架/更新的论文。即便上一轮在入库前崩溃、
 *   或某轮整源失败被 allSettled 隔离，下一轮仍重抓同一窗口，崩溃丢失的条目在窗口内被重新拉回。
 *   只要采集间隔（日报每日一跑）远小于 7 天窗口，任何一轮的失败都被后续轮次的窗口重叠吸收。
 * - **重抓幂等**：窗口重叠必然重复拉到已入库的论文；store 层 `INSERT ... ON CONFLICT
 *   (source, source_item_id) DO NOTHING` 幂等吸收重抓，不产生重复行。
 * - **crash-safe**：无持久化状态可被「崩在推进与入库之间」破坏（commit no-op），故无需「入库成功后
 *   才推进游标」的精细时序——这是固定窗口相对「派生游标」方案的核心简化。
 *
 * P2 论文仅落 raw_items 作沉淀（collapsed=true、不进事件塌缩/日报/推送），属低风险数据；
 * 固定窗口的少量重抓开销（被 UNIQUE 吸收）完全可接受，换来零漏窗 + 零额外 schema。
 */
import type { ArxivCursorStore } from './arxiv.js';

/** 固定回溯窗口天数（保守值）：每轮重抓近 N 天的 arXiv 论文，窗口重叠 + UNIQUE 保证无漏窗。 */
export const ARXIV_LOOKBACK_DAYS = 7;

/**
 * 固定回溯窗口游标存储：`load()` 返回 `now - lookbackDays`，`commit` no-op。
 *
 * @param lookbackDays 回溯窗口天数（默认 ARXIV_LOOKBACK_DAYS=7）。
 * @param now 注入时钟（默认 Date.now），便于单测确定 `from` 边界。
 */
export function createLookbackArxivCursorStore(
  lookbackDays: number = ARXIV_LOOKBACK_DAYS,
  now: () => number = Date.now,
): ArxivCursorStore {
  return {
    async load(): Promise<Date | null> {
      return new Date(now() - lookbackDays * 24 * 60 * 60 * 1000);
    },
    // no-op：固定窗口不持久化游标；at-least-once 由窗口重叠 + UNIQUE 兜底，无需推进。
    async commit(): Promise<void> {
      // 故意留空：每轮重抓固定窗口，无可推进的持久化状态。
    },
  };
}
