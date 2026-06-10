/**
 * Value Judge 落库往返的 DB 读写（任务 5.4 / spec「Agent 输出落库往返」）。
 *
 * 仅承载「按映射写入 ai_news_events 评分列」与「读回该行」两个动作；
 * 字段名映射逻辑在 ./mapping.ts，本模块只负责 DB 交互，便于测试与复用。
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { ValueJudgeOutput } from './schema.js';
import { mapOutputToEventScores } from './mapping.js';

export interface SeededRawItem {
  /** seed 入库后的 raw_item 主键（bigint）。 */
  id: bigint;
  title: string;
}

/**
 * seed 一条假 raw_item 入库（任务 5.4）。
 * source_item_id 用时间戳保证可重复运行不撞 UNIQUE(source, source_item_id)。
 */
export async function seedRawItem(): Promise<SeededRawItem> {
  const title = '[seed] A new open-source coding agent with GitHub integration';
  const [row] = await db
    .insert(schema.rawItems)
    .values({
      source: 'seed',
      sourceItemId: `seed-${Date.now()}`,
      rawType: 'open_source',
      title,
      content:
        'An open-source coding agent supporting local execution and GitHub integration.',
    })
    .returning({ id: schema.rawItems.id });
  if (!row) {
    throw new Error('seedRawItem 未返回插入行');
  }
  return { id: row.id, title };
}

/** ai_news_events 读回行（仅评分相关列，用于往返比对）。 */
export interface PersistedEventScores {
  eventId: string;
  importanceScore: string | null;
  noveltyScore: string | null;
  developerRelevanceScore: string | null;
  hypeRiskScore: string | null;
  shouldPush: boolean | null;
}

/**
 * 把经校验的 Value Judge 输出按映射写入 ai_news_events（任务 5.4）。
 *
 * event_id 用 seed 的稳定值（`seed-<rawItemId>`）；representative_title 等
 * 非评分列填 seed 值。评分列经 mapOutputToEventScores 显式映射。
 *
 * @returns 写入使用的 event_id。
 */
export async function persistEventScores(
  rawItemId: bigint,
  output: ValueJudgeOutput,
  representativeTitle: string,
): Promise<string> {
  const eventId = `seed-${rawItemId.toString()}`;
  const scores = mapOutputToEventScores(output);
  await db
    .insert(schema.aiNewsEvents)
    .values({
      eventId,
      eventType: output.type,
      representativeTitle,
      importanceScore: scores.importanceScore,
      noveltyScore: scores.noveltyScore,
      developerRelevanceScore: scores.developerRelevanceScore,
      hypeRiskScore: scores.hypeRiskScore,
      shouldPush: scores.shouldPush,
    })
    .onConflictDoUpdate({
      target: schema.aiNewsEvents.eventId,
      set: {
        importanceScore: scores.importanceScore,
        noveltyScore: scores.noveltyScore,
        developerRelevanceScore: scores.developerRelevanceScore,
        hypeRiskScore: scores.hypeRiskScore,
        shouldPush: scores.shouldPush,
      },
    });
  return eventId;
}

/** 从 ai_news_events 读回某 event 的评分列（任务 5.4 往返比对）。 */
export async function readBackEventScores(
  eventId: string,
): Promise<PersistedEventScores | null> {
  const rows = await db
    .select({
      eventId: schema.aiNewsEvents.eventId,
      importanceScore: schema.aiNewsEvents.importanceScore,
      noveltyScore: schema.aiNewsEvents.noveltyScore,
      developerRelevanceScore: schema.aiNewsEvents.developerRelevanceScore,
      hypeRiskScore: schema.aiNewsEvents.hypeRiskScore,
      shouldPush: schema.aiNewsEvents.shouldPush,
    })
    .from(schema.aiNewsEvents)
    .where(eq(schema.aiNewsEvents.eventId, eventId))
    .limit(1);
  return rows[0] ?? null;
}
