/**
 * 发布时间推断 Agent 输出契约（published-at-inference 1.1，design D2）。
 *
 * 定位等同 Value Judge：LLM 只填补 `published_at` 这一语义空缺，**禁止**参与
 * 「是否够新 / 是否推送」的状态判断（最终过滤与状态由程序 + DB 确定性保障）。
 *
 * 输出形如 `{ publishedAt: string | null, confidence?: number, basis?: string }`：
 * - `publishedAt`：推断出的发布时间（ISO 日期/时刻串）或 `null`（无法判定）。
 * - `confidence` / `basis`：仅用于**运行期日志**，不落库（design D3：本期不加 provenance 列）。
 *
 * **合理范围校验（命门，design D2 / spec「越界等同无法判定」）**：
 * 经 `refine` 约束 `合理下限 <= publishedAt <= now`——拒未来日期（晚于 now）与荒谬过早日期
 * （早于合理下限）。越界即**视同无法判定**（不抛、由调用方按 NULL 处理）。理由：
 * `gte(published_at, lowerBound)` 时效闸对未来日期恒为真，若放任未来/荒谬日期回填，被推错的
 * 事件会绕过时效闸、反而放大本提案要堵的漏洞。这是 Zod 层（拦 AI 未来值）与回填 SQL 层
 * `WHERE 推断日期 <= now()`（拦任何来源未来值）双层防御的第一层。
 *
 * `now` 由调用方注入（默认 `new Date()`）便于测试固化边界。
 */
import { z } from 'zod';

/**
 * 合理下限常量：早于此时刻的推断结果视同荒谬过早、按无法判定处理。
 * 取 1990-01-01（远早于任何 AI 行业内容的发布年份，宽松兜底；过早值多为 LLM 幻觉）。
 */
export const REASONABLE_LOWER_BOUND = new Date('1990-01-01T00:00:00Z');

/**
 * 构造经合理范围 refine 的输出 schema。
 *
 * 把范围校验做成「构造函数 + 注入 now」而非模块级常量，使测试可固定 now 断言上界
 * （未来日期被拒）。`publishedAt` 必须是可被 `Date` 解析的 ISO 串，且解析后落在
 * `[REASONABLE_LOWER_BOUND, now]` 闭区间；任一不满足 → 该字段置 `null`（无法判定）。
 *
 * 注意：refine 不抛错、不在 schema 内「修正」越界为 null（zod refine 只能判真假）；
 * 故采用 `transform`：先解析为 Date，越界/非法即归一为 `null`。这样 schema 输出恒为
 * 「合法 ISO 串（在范围内）或 null」，调用方拿到 null 即按无法判定处理（绝不回填）。
 *
 * @param now 当前参考时刻（上界），默认 `new Date()`。
 */
export function makePublishedAtInferenceSchema(now: Date = new Date()) {
  const upperMs = now.getTime();
  const lowerMs = REASONABLE_LOWER_BOUND.getTime();

  return z.object({
    /**
     * 推断出的发布时间（ISO 串）或 null（无法判定）。
     * 经 transform 归一：非法/越界（未来 or 早于合理下限）一律归为 null——绝不回填越界值。
     */
    publishedAt: z
      .union([z.string(), z.null()])
      .transform((raw): string | null => {
        if (raw === null) return null;
        const trimmed = raw.trim();
        if (trimmed.length === 0) return null;
        const parsed = new Date(trimmed);
        const ms = parsed.getTime();
        if (Number.isNaN(ms)) return null; // 非法日期串 → 无法判定。
        // 合理范围闭区间 [下限, now]：越界（未来 or 荒谬过早）→ 无法判定（NULL），绝不回填。
        if (ms < lowerMs || ms > upperMs) return null;
        return parsed.toISOString();
      }),
    /** 置信度 0–1（可选，仅日志，不落库）。 */
    confidence: z.number().min(0).max(1).optional(),
    /** 推断依据（可选，自由文本，仅日志，不落库）。 */
    basis: z.string().optional(),
  });
}

/** 经校验的发布时间推断输出类型（publishedAt 归一为「合法 ISO 串或 null」）。 */
export type PublishedAtInferenceOutput = z.infer<
  ReturnType<typeof makePublishedAtInferenceSchema>
>;
