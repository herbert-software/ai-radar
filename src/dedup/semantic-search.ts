/**
 * 语义去重第三层：embedding 相似度候选检索 + 阈值分流（add-semantic-dedup-and-store-hardening，
 * 组 D 任务 4.1 / 4.2，spec「embedding 相似度候选检索与阈值分流」）。
 *
 * 职责（在硬去重塌缩之后、value-judge 之前，仅日报链）：
 * - 4.1 候选检索：对一条带 embedding 的待判事件，在时间窗内（`first_seen_at >= now()-windowDays`）、
 *   **排除自身**与 **tombstone**（仅 `merged_into IS NULL` 候选）、按 pgvector 余弦距离 `embedding <=> $q`
 *   取最近 K（默认 10），`cosine_sim = 1 - distance`。
 * - 4.2 阈值分流（边界语义显式钉死，避免浮点 `==` 歧义）：
 *     `cosine_sim > SEMANTIC_DEDUP_HIGH`（默认 0.88）          → 'high-auto'（直接判同事件、合并，不调 LLM）
 *     `SEMANTIC_DEDUP_LLM`（默认 0.82）< sim ≤ HIGH          → 'llm-gray'（交 LLM 二次判断）
 *     `cosine_sim ≤ SEMANTIC_DEDUP_LLM`                       → 'no-merge'（不合并）
 *
 * 关键不变量（spec / design D4，逐条守住）：
 * - 排除自身：候选 SELECT 带 `event_id <> $self`，绝不把自己当候选。
 * - 排除 tombstone：候选只取 `merged_into IS NULL`（被吞 tombstone 不参与检索）。
 * - 排除无 embedding 候选：`embedding IS NOT NULL`（无向量者无法计距，不入候选）。
 * - **本模块只产「候选 + 相似度 + 档位建议」，绝不落库**——是否合并的最终落库由 merge-events 程序 +
 *   DB 单事务执行（spec「确定性事件合并」）。
 * - 阈值经 env 可配（SEMANTIC_DEDUP_HIGH / SEMANTIC_DEDUP_LLM / SEMANTIC_WINDOW_DAYS），默认取 QA 值。
 *
 * pgvector 向量传参：本仓 schema.ts 的 `vector` customType 仅有 `toDriver`（序列化为 `[v1,v2,...]`），
 * 无 drizzle 原生距离算子，故候选检索用参数化 raw SQL 的 `embedding <=> $q::vector`——查询向量经
 * `toPgVectorLiteral` 序列化为 pgvector 字面量字符串、作占位符绑定（绝不字符串拼接注入）。
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents } from '../db/schema.js';
import { env } from '../config/env.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 阈值分流档位（边界显式钉死）。 */
export type SimilarityTier = 'high-auto' | 'llm-gray' | 'no-merge';

/** 一条窗内候选（含余弦相似度）。 */
export interface SemanticCandidate {
  /** 候选事件 event_id（非待判自身、非 tombstone、有 embedding）。 */
  eventId: string;
  /** 余弦相似度 `1 - distance`（distance = pgvector `<=>`）。 */
  cosineSim: number;
}

/** 候选检索 + 分流的可注入参数。 */
export interface SemanticSearchOptions {
  /** 候选时间窗天数（默认 env.SEMANTIC_WINDOW_DAYS=14）。 */
  windowDays?: number;
  /** 取最近 K 个候选（默认 10）。 */
  topK?: number;
  /** 高相似度直接合并阈值（默认 env.SEMANTIC_DEDUP_HIGH=0.88）。 */
  highThreshold?: number;
  /** LLM 二次判断下界阈值（默认 env.SEMANTIC_DEDUP_LLM=0.82）。 */
  llmThreshold?: number;
}

/** 默认取最近 K 个候选。 */
const DEFAULT_TOP_K = 10;

/**
 * 把查询向量序列化为 pgvector 字面量字符串 `[v1,v2,...]`（作参数化占位符绑定、`::vector` 转型）。
 * 与 schema.ts vector customType 的 toDriver 同口径。非有限值（NaN/Inf）会被 PG 拒绝——属上游
 * embedding 异常，让 DB 报错优于静默错配（绝不静默替换为 0）。
 */
function toPgVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * 据余弦相似度做阈值分流（边界语义显式钉死，避免浮点 `==` 歧义，spec「阈值分流」）：
 *   sim > high          → 'high-auto'
 *   llm < sim ≤ high    → 'llm-gray'
 *   sim ≤ llm           → 'no-merge'
 *
 * @param sim 余弦相似度。
 * @param high 高相似度直接合并阈值（默认 env.SEMANTIC_DEDUP_HIGH）。
 * @param llm  LLM 二次判断下界阈值（默认 env.SEMANTIC_DEDUP_LLM）。
 */
export function classifySimilarity(
  sim: number,
  high: number = env.SEMANTIC_DEDUP_HIGH,
  llm: number = env.SEMANTIC_DEDUP_LLM,
): SimilarityTier {
  if (sim > high) return 'high-auto';
  if (sim > llm) return 'llm-gray'; // 此分支已知 sim ≤ high（上一 if 未命中），即 (llm, high]
  return 'no-merge';
}

/**
 * 对一条待判事件检索窗内 KNN 候选（4.1）：排除自身 + tombstone + 无 embedding，按余弦距离取最近 K，
 * 返回 `cosine_sim = 1 - distance`（按相似度降序，即距离升序）。
 *
 * @param self      待判事件 event_id（候选 SELECT 用 `<> self` 排除自身）。
 * @param queryVec  待判事件的 embedding 向量（与 self 同事件的向量）。
 * @param options   可注入 windowDays / topK。
 * @param dbh       可注入 db 或事务句柄（默认全局 db）。
 */
export async function searchSimilarCandidates(
  self: string,
  queryVec: readonly number[],
  options: SemanticSearchOptions = {},
  dbh: DbLike = defaultDb,
): Promise<SemanticCandidate[]> {
  const windowDays = options.windowDays ?? env.SEMANTIC_WINDOW_DAYS;
  const topK = options.topK ?? DEFAULT_TOP_K;

  // 空向量直接返回空候选（不应发生——调用方应保证 self 已嵌；防御性短路，绝不对空向量发起检索）。
  if (queryVec.length === 0) return [];

  const queryLiteral = toPgVectorLiteral(queryVec);
  // 候选窗口下界：now() - interval（参数化天数，DB 端时钟统一口径，防进程钟漂）。
  const windowCutoff = sql`now() - (${windowDays}::double precision * interval '1 day')`;
  // 余弦距离 distance = embedding <=> $q::vector；cosine_sim = 1 - distance。
  // queryLiteral 作占位符绑定、`::vector` 转型（参数化，禁字符串拼接 SQL）。
  const distanceExpr = sql<number>`(${aiNewsEvents.embedding} <=> ${queryLiteral}::vector)`;

  const rows = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      distance: distanceExpr,
    })
    .from(aiNewsEvents)
    .where(
      sql`${aiNewsEvents.embedding} IS NOT NULL
        AND ${aiNewsEvents.mergedInto} IS NULL
        AND ${aiNewsEvents.eventId} <> ${self}
        AND ${aiNewsEvents.firstSeenAt} >= ${windowCutoff}`,
    )
    .orderBy(distanceExpr) // 距离升序 = 相似度降序（最近的候选在前）。
    .limit(topK);

  return rows.map((r) => {
    const distance = Number(r.distance);
    const cosineSim = Number.isFinite(distance) ? 1 - distance : Number.NEGATIVE_INFINITY;
    return { eventId: r.eventId, cosineSim };
  });
}
