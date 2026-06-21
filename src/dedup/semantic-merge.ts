/**
 * 语义层编排入口（add-semantic-dedup-and-store-hardening，组 D 额外，供组 F 在 6.1 接线）。
 *
 * 组合语义去重第三/四层 + 确定性合并的完整一轮：
 *   组 C `runEmbeddingBootstrap`（嵌候选窗口内所有 embedding IS NULL 的存活事件）
 *   → 对每个待判事件 4.1 检索窗内 KNN 候选
 *   → 4.2 阈值分流（high-auto / llm-gray / no-merge）
 *   → 灰区调 4.3 judge（LLM 二次判断，失败降级=不合并）
 *   → 4.4 mergeEvents（程序 + DB 单事务确定性合并）
 *
 * 关键不变量（绝不可违背，spec / design D3/D5/D6）：
 * - **仅日报链调用**、仅作用于 `ai_news_events`（新闻事件），绝不作用于 ai_products。
 * - 最终是否合并的落库由**程序 + DB 单事务**执行；LLM 仅产 `same_event`/`same_product`/`reason` 建议；
 *   `same_product` 本期**仅采集不消费**，绝不触发 ai_products 合并。
 * - **降级一律 = 不合并、不抛断**：embedding 失败（runEmbeddingBootstrap 内部已降级跳过）/ 检索异常 /
 *   LLM judge 降级 / 合并冲突——任一逐事件 catch、记日志、保留独立，绝不中止整批（欠合并安全）。
 * - `SEMANTIC_DEDUP_ENABLED` 开关由组 F 在 run-daily 层处理（本模块只导出函数，不读开关、不改 pipeline）。
 *
 * **合并对待判集的影响（迭代安全）**：一轮内待判事件可能在前序合并中被吞为 tombstone。逐事件处理前
 * 重读其当前 embedding/merged_into：若已成 tombstone（merged_into 非空）则跳过（已被合并、不再作查询
 * 对象）；mergeEvents 内部对两侧都链解析到终态、noop 同终态行，故重复/交叉判定安全。
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, rawItems } from '../db/schema.js';
import { env } from '../config/env.js';
import {
  runEmbeddingBootstrap,
  type EmbeddingBootstrapOptions,
  type EmbeddingBootstrapResult,
} from './embedding.js';
import {
  searchSimilarCandidates,
  classifySimilarity,
  type SemanticSearchOptions,
} from './semantic-search.js';
import {
  judgeSameEvent,
  type SemanticJudgeOptions,
} from './semantic-judge.js';
import { mergeEvents, type MergeTier } from './merge-events.js';
import { shouldVetoMerge } from './merge-guard.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 一轮语义合并的统计结果（供编排/可观测）。 */
export interface SemanticMergeResult {
  /** embedding bootstrap 统计（嵌入候选窗口）。 */
  embedding: EmbeddingBootstrapResult;
  /** 本轮检索/分流处理的待判事件数（有 embedding、非 tombstone、窗内）。 */
  processed: number;
  /** 高相似度直接合并（high-auto）的合并次数。 */
  highAutoMerged: number;
  /** 灰区经 LLM 判 same 并合并（llm-confirmed）的合并次数。 */
  llmConfirmedMerged: number;
  /** 灰区 LLM 判不同 / 降级（不合并）的次数。 */
  llmNotMerged: number;
  /** 因逐事件异常被跳过（保留独立、不中止）的次数。 */
  skippedError: number;
  /** 因确定性精度护栏（两侧标题数字/版本 token 集不同）否决合并的次数。 */
  vetoedByGuard: number;
}

export interface SemanticMergeOptions {
  /** 参考时刻（决定窗口；透传给 embedding bootstrap 不需要，检索用 DB now()）。 */
  now?: Date;
  /** 本轮 collapse 新产出的事件 id 集（嵌入顺序先嵌这些；透传给 runEmbeddingBootstrap）。 */
  thisRoundEventIds?: readonly string[];
  /** 透传给 runEmbeddingBootstrap 的选项（embed 桩 / maxPerRun / windowDays 等）。 */
  embedding?: Omit<EmbeddingBootstrapOptions, 'thisRoundEventIds'>;
  /** 透传给候选检索的选项（windowDays / topK / 阈值）。 */
  search?: SemanticSearchOptions;
  /** 透传给 LLM 二次判断的选项（注入 mock generateObjectFn / maxAttempts）。 */
  judge?: SemanticJudgeOptions;
  /** 错误/信息日志 sink，默认 console.error。 */
  logError?: (message: string, detail: unknown) => void;
}

/** 一条待判事件的最小视图（含 embedding 与代表 content，供检索查询向量 + judge prompt）。 */
interface PendingJudgeEvent {
  eventId: string;
  representativeTitle: string | null;
  content: string | null;
  mainEntities: unknown;
  embedding: number[] | null;
  mergedInto: string | null;
}

/** 归一化 pgvector 读回值为 `number[]`。schema 的 vector customType 现已定义 `fromDriver`（读回即
 *  `number[]`），本函数保留作防御性归一化：兼容 `number[]`（直接返回）与遗留 `[v1,v2,...]` 字符串形态。 */
function parsePgVector(value: unknown): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length < 2) return null;
    // 形如 [0.1,0.2,...]；去括号后按逗号切分。
    const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '');
    if (inner.length === 0) return null;
    const nums = inner.split(',').map((s) => Number(s));
    return nums.every((n) => Number.isFinite(n)) ? nums : null;
  }
  return null;
}

/**
 * 跑一轮完整语义合并（仅日报链、仅 ai_news_events）。
 *
 * @param options 注入点（thisRoundEventIds / embedding / search / judge 桩）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function semanticMergeEvents(
  options: SemanticMergeOptions = {},
  dbh: DbLike = defaultDb,
): Promise<SemanticMergeResult> {
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[semantic-merge] ${message}`, detail));
  const windowDays = options.search?.windowDays ?? env.SEMANTIC_WINDOW_DAYS;

  // ── 步骤 1：embedding bootstrap（嵌候选窗口内所有 embedding IS NULL 的存活事件；幂等、带上限）。
  // 失败逐条降级（内部已处理，不抛）；本编排不因 embedding 失败中止。
  const embeddingResult = await runEmbeddingBootstrap(
    {
      ...options.embedding,
      ...(options.thisRoundEventIds !== undefined
        ? { thisRoundEventIds: options.thisRoundEventIds }
        : {}),
    },
    dbh,
  );

  // ── 步骤 2：取本轮待判事件集 = 窗内、非 tombstone、有 embedding 的事件（含历史存活者作查询对象）。
  // 待判对象优先本轮新事件（thisRoundEventIds），但历史存活者也可能与新事件互为候选；以「有 embedding
  // 的窗内存活事件」为待判集，逐事件检索候选——任一对被判同事件即合并（mergeEvents 幂等于重复对）。
  const windowCutoff = sql`now() - (${windowDays}::double precision * interval '1 day')`;
  const rows = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      mainEntities: aiNewsEvents.mainEntities,
      embedding: aiNewsEvents.embedding,
      mergedInto: aiNewsEvents.mergedInto,
      content: rawItems.content,
    })
    .from(aiNewsEvents)
    .leftJoin(rawItems, sql`${aiNewsEvents.representativeRawItemId} = ${rawItems.id}`)
    .where(
      sql`${aiNewsEvents.embedding} IS NOT NULL
        AND ${aiNewsEvents.mergedInto} IS NULL
        AND ${aiNewsEvents.firstSeenAt} >= ${windowCutoff}`,
    )
    .orderBy(sql`${aiNewsEvents.firstSeenAt} ASC`);

  const pending: PendingJudgeEvent[] = rows.map((r) => ({
    eventId: r.eventId,
    representativeTitle: r.representativeTitle,
    content: r.content,
    mainEntities: r.mainEntities,
    embedding: parsePgVector(r.embedding),
    mergedInto: r.mergedInto,
  }));

  let processed = 0;
  let highAutoMerged = 0;
  let llmConfirmedMerged = 0;
  let llmNotMerged = 0;
  let skippedError = 0;
  let vetoedByGuard = 0;

  for (const ev of pending) {
    try {
      // 一轮内本事件可能在前序合并中已被吞为 tombstone：重读当前状态，已 tombstone → 跳过（不再作查询对象）。
      const cur = await dbh
        .select({ embedding: aiNewsEvents.embedding, mergedInto: aiNewsEvents.mergedInto })
        .from(aiNewsEvents)
        .where(sql`${aiNewsEvents.eventId} = ${ev.eventId}`)
        .limit(1);
      const curRow = cur[0];
      if (!curRow || curRow.mergedInto !== null) continue;
      const queryVec = parsePgVector(curRow.embedding);
      if (queryVec === null || queryVec.length === 0) continue;

      processed += 1;

      // 4.1 检索窗内 KNN 候选（排除自身 + tombstone + 无 embedding）。
      const candidates = await searchSimilarCandidates(
        ev.eventId,
        queryVec,
        options.search ?? {},
        dbh,
      );

      // 逐候选按相似度降序（searchSimilarCandidates 已按距离升序），高档优先尝试合并。
      for (const cand of candidates) {
        const tier = classifySimilarity(
          cand.cosineSim,
          options.search?.highThreshold,
          options.search?.llmThreshold,
        );
        if (tier === 'no-merge') {
          // 候选已按相似度降序，遇到 no-merge 即后续更低，无需再看该事件的其余候选。
          break;
        }

        // 合并前确定性精度护栏：两侧标题数字/版本 token 集不同即否决该候选（high-auto 与
        // llm-confirmed 两路前置、优先于阈值分流与 LLM；灰区 token 不同的对直接否决、不调 LLM 省成本）。
        // candTitle 复用给灰区 judge，省一次 DB 往返。
        const candTitle = await loadTitle(dbh, cand.eventId);
        if (shouldVetoMerge(ev.representativeTitle, candTitle)) {
          vetoedByGuard += 1;
          // continue（不 break）：高相似度的版本变体邻居不应埋掉更低相似度的真同事件候选。
          continue;
        }

        let mergeTier: MergeTier;
        let reason: string | undefined;

        if (tier === 'high-auto') {
          mergeTier = 'high-auto';
        } else {
          // 灰区：调 LLM 二次判断（失败降级=不合并、不抛）。
          const judged = await judgeSameEvent(
            {
              titleA: ev.representativeTitle ?? '',
              contentA: ev.content,
              titleB: candTitle,
              contentB: await loadContent(dbh, cand.eventId),
            },
            options.judge,
          );
          if (!judged.sameEvent) {
            llmNotMerged += 1;
            continue; // 不合并该候选，继续看下一候选。
          }
          mergeTier = 'llm-confirmed';
          reason = judged.reason;
        }

        // 4.4 程序 + DB 单事务确定性合并（链解析到终态、noop 同终态行、记 provenance）。
        const outcome = await mergeEvents(
          ev.eventId,
          cand.eventId,
          {
            cosineSim: cand.cosineSim,
            tier: mergeTier,
            ...(reason !== undefined ? { reason } : {}),
          },
          dbh,
        );
        if (outcome.status === 'merged') {
          if (mergeTier === 'high-auto') highAutoMerged += 1;
          else llmConfirmedMerged += 1;
          // 本事件可能已被吞（若它是较新者）；跳出候选循环，进入下一待判事件（重读会跳过已 tombstone）。
          break;
        }
        // noop（两侧已同终态）：不计合并，继续看下一候选。
      }
    } catch (error) {
      // 逐事件异常（检索/judge/合并冲突）：保留独立、记日志、不中止整批（欠合并安全）。
      skippedError += 1;
      logError(`事件 ${ev.eventId} 语义合并处理异常（保留独立，不中止整批）`, error);
    }
  }

  return {
    embedding: embeddingResult,
    processed,
    highAutoMerged,
    llmConfirmedMerged,
    llmNotMerged,
    skippedError,
    vetoedByGuard,
  };
}

/** 读某事件代表标题（灰区 judge prompt 用；缺则空串）。 */
async function loadTitle(dbh: DbLike, eventId: string): Promise<string> {
  const rows = await dbh
    .select({ representativeTitle: aiNewsEvents.representativeTitle })
    .from(aiNewsEvents)
    .where(sql`${aiNewsEvents.eventId} = ${eventId}`)
    .limit(1);
  return rows[0]?.representativeTitle ?? '';
}

/** 读某事件代表 raw_item content（灰区 judge prompt 用；缺则 null）。 */
async function loadContent(dbh: DbLike, eventId: string): Promise<string | null> {
  const rows = await dbh
    .select({ content: rawItems.content })
    .from(aiNewsEvents)
    .leftJoin(rawItems, sql`${aiNewsEvents.representativeRawItemId} = ${rawItems.id}`)
    .where(sql`${aiNewsEvents.eventId} = ${eventId}`)
    .limit(1);
  return rows[0]?.content ?? null;
}
