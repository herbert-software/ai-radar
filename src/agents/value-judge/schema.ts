/**
 * Value Judge Agent 输出契约（任务 5.1）。
 *
 * 字段逐一对齐 QA.md §10.4 的输出 JSON：
 *   is_ai_related / type / category / importance / novelty /
 *   developer_relevance / hype_risk / should_push / reason
 *
 * 关键不变量（spec「结构化价值判断契约」）：
 * Agent 输出必须经此 Zod schema 校验通过，禁止以非结构化文本形式返回或入库。
 *
 * 注意映射陷阱（spec「Agent 输出落库往返」/ design D4）：
 * 本 schema 字段**无** `_score` 后缀；落库到 ai_news_events 时需显式映射到
 * `*_score` 列，禁止假定同名直插。映射逻辑见 ./mapping.ts。
 */
import { z } from 'zod';

/**
 * 0–100 评分字段公共约束。
 *
 * 必须为整数（`.int()`）：QA.md §10.4 的评分输出均为整数，且落库列为
 * `NUMERIC(5,2)`——若放行小数（如 82.555），DB 会静默四舍五入到 82.56，
 * 使「读回各 *_score 列与 Agent 输出一致」的往返比对（roundtrip.ts）假阴性。
 * 用 `.int()` 把小数挡在 Zod 层（触发重试/降级，不落库），与 NUMERIC 整数语义对齐。
 */
const scoreField = z.number().int().min(0).max(100);

/**
 * Value Judge 输出 schema（雏形；P1 可走 MODIFIED 演进真实判断逻辑）。
 */
export const valueJudgeOutputSchema = z.object({
  /** 是否与 AI 相关。 */
  is_ai_related: z.boolean(),
  /** 类型：新闻 / 产品 / 论文 / 开源项目 / 工具更新 等（自由字符串，P1 可收紧为枚举）。 */
  type: z.string().min(1),
  /** 重点分类（如 "AI Coding"）。 */
  category: z.string().min(1),
  /** 重要性评分 0–100。 */
  importance: scoreField,
  /** 新颖性评分 0–100。 */
  novelty: scoreField,
  /** 开发者相关性评分 0–100。 */
  developer_relevance: scoreField,
  /** 炒作风险评分 0–100。 */
  hype_risk: scoreField,
  /** 是否应推送。 */
  should_push: z.boolean(),
  /** 判断理由（自然语言）。 */
  reason: z.string().min(1),
});

/** 经校验的 Value Judge 输出类型。 */
export type ValueJudgeOutput = z.infer<typeof valueJudgeOutputSchema>;
