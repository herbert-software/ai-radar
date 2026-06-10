/**
 * Agent 输出 → ai_news_events 列 的字段名映射（任务 5.4 / design D4 关键陷阱）。
 *
 * §10.4 输出字段**无** `_score` 后缀，§8.2 `ai_news_events` 评分列**带** `_score` 后缀，
 * 二者不同名。落库前必须显式映射，禁止假定同名直插——否则「读回一致」验收无法成立。
 *
 * | Agent 输出字段        | ai_news_events 列          |
 * |----------------------|----------------------------|
 * | importance           | importance_score           |
 * | novelty              | novelty_score              |
 * | developer_relevance  | developer_relevance_score  |
 * | hype_risk            | hype_risk_score            |
 * | should_push          | should_push（同名直写）     |
 */
import type { ValueJudgeOutput } from './schema.js';

/**
 * 待写入 ai_news_events 评分相关列的子集（用 Drizzle 列名 / camelCase 表达）。
 * NUMERIC 列经由 Drizzle 以字符串形式写入，避免浮点精度漂移。
 */
export interface AiNewsEventScoreColumns {
  importanceScore: string;
  noveltyScore: string;
  developerRelevanceScore: string;
  hypeRiskScore: string;
  shouldPush: boolean;
}

/**
 * 把经校验的 Value Judge 输出映射为 ai_news_events 的评分列。
 *
 * 显式逐字段映射（不依赖同名）：
 *   importance          → importance_score
 *   novelty             → novelty_score
 *   developer_relevance → developer_relevance_score
 *   hype_risk           → hype_risk_score
 *   should_push         → should_push（同名）
 *
 * 数值列转成字符串交给 Drizzle 的 numeric 列，保证精度（NUMERIC(5,2)）。
 */
export function mapOutputToEventScores(
  output: ValueJudgeOutput,
): AiNewsEventScoreColumns {
  return {
    importanceScore: String(output.importance),
    noveltyScore: String(output.novelty),
    developerRelevanceScore: String(output.developer_relevance),
    hypeRiskScore: String(output.hype_risk),
    shouldPush: output.should_push,
  };
}
