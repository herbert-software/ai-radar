/**
 * 知识库入库编排入口（add-semantic-dedup-and-store-hardening，组 E / spec「知识库准入闸只入精选」
 * + design D7；供组 F 在 6.2 于 push 之后接线）。
 *
 * 流程（确定性工作流 + DB 状态 + Agent 语义 + 程序入库，对齐架构原则）：
 * 1. **选候选（准入候选域，5.2）**：候选 = 当日**实际推送成功**（`push_records.status='success'`、
 *    `target_type='event'`、`push_date=今日`）**且** `ai_news_events.merged_into IS NULL`（非 tombstone）
 *    的 event——单一口径（排除 tombstone 与落选事件，控成本，对齐流水线 Push → KB Ingestion 顺序）。
 * 2. **逐条 KB Agent 产元数据（5.1）**：generateKbMetadata（generateObject + Zod，含 long_term_value
 *    钉死 [0,100]）；校验不过 / 重试耗尽 → 记日志、**跳过该条不入库、不中止整批**。
 * 3. **准入闸（程序，5.2）**：仅 `long_term_value >= 70` 入库（QA §13.1 知识库不是垃圾桶）；
 *    准入闸为**程序判定**（非 LLM 决定是否入库）。低于阈值 → 记录为未达阈、跳过。
 * 4. **embedding**：对 `kb_title + summary_zh` 经 embedTexts（复用组 C 低层原语）生成；失败 → 记日志、
 *    embedding 置 null（不阻断入库，列可空、供未来检索）。Agent/embed 失败一律跳过该条或降级 embedding，
 *    **不抛断、不污染 KB**。
 * 5. **状态感知认领 + 两表原子入库（5.3）**：storeKbDocument（claim CAS + 同事务两表写入 / 失败回滚置 failed）。
 *
 * kb_provider='custom'（本地表）。本阶段运行在日报链单例锁内、在 push 之后。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, pushRecords, rawItems } from '../db/schema.js';
import { getPushDate } from '../push/push-date.js';
import { TARGET_TYPE, type TargetType } from '../push/targets.js';
import { embedTexts, type EmbedTextsOptions } from '../dedup/embedding.js';
import {
  generateKbMetadata,
  type KbIngestionAgentOptions,
} from './ingestion-agent.js';
import { storeKbDocument, KB_PROVIDER_CUSTOM, type KbStoreOptions } from './store.js';

export { generateKbMetadata, KbIngestionAgentFailureError } from './ingestion-agent.js';
export {
  storeKbDocument,
  KB_PROVIDER_CUSTOM,
  type KbStoreItem,
  type KbStoreOutcome,
} from './store.js';
export { kbIngestionMetadataSchema, type KbIngestionMetadata } from './schema.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/**
 * 知识库准入闸阈值（复用 long_term_value >= 70 不变量；列在 env 暂无，硬钉常量与 QA §13.1 一致）。
 *
 * **单一来源（add-ai-blogger-experience-mining，design D5 / spec）**：本常量是全仓库唯一的 `70`
 * 准入闸。事件链 runKbIngestion、经验链 KB 准入 runExperienceKbIngestion 与实践锦囊推送候选
 * （pipeline/experience-chain）三处共同 `import` 本常量，**禁止任一处写字面量 70**（否则违背
 * 「单一 70」不变量、埋「改 KB 闸为 75 但推送仍 70」的口径分裂）。
 */
export const KB_ADMISSION_FLOOR = 70;

/** 一轮 KB 入库的统计结果（供编排/可观测）。 */
export interface KbIngestionResult {
  /** 当日候选（push success + 非 tombstone）event 数。 */
  candidates: number;
  /** KB Agent 产出元数据成功（经 Zod 校验）的条数。 */
  agentOk: number;
  /** KB Agent 失败/校验不过被跳过的条数（不入库、不中止整批）。 */
  agentFailed: number;
  /** 准入闸拦下（long_term_value < 70）的条数。 */
  gatedOut: number;
  /** 实际新增 kb_documents 的条数。 */
  ingested: number;
  /** 认领未抢到（已 success）被跳过的条数。 */
  skippedClaimed: number;
  /** 认领成功但写入失败（已回滚、置 failed 待重试）的条数。 */
  storeFailed: number;
}

export interface RunKbIngestionOptions {
  /** 参考时刻，决定候选的 push_date（默认当前时刻，与 dispatcher getPushDate 同源）。 */
  now?: Date;
  /** kb_provider，默认 'custom'（本地表）。 */
  kbProvider?: string;
  /** 透传给知识摘要 Agent 的选项（注入 mock generateObjectFn / maxAttempts / logError）。 */
  agent?: KbIngestionAgentOptions;
  /** 透传给 embedTexts 的选项（注入 mock embedManyFn / maxAttempts / logError）。 */
  embed?: EmbedTextsOptions;
  /** 透传给 storeKbDocument 的选项（logError 等；kbProvider 由本编排统一注入）。 */
  store?: Omit<KbStoreOptions, 'kbProvider'>;
  /** 错误/信息日志 sink，默认 console.error；便于测试断言（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
  /** 目标实体类型，默认 'event'（本期仅事件入库）。 */
  targetType?: TargetType;
}

/** 候选事件的最小视图（含代表 raw_item content 回指 + 来源 URL，供 Agent 与 embedding）。 */
interface KbCandidateEvent {
  eventId: string;
  representativeTitle: string | null;
  summaryZh: string | null;
  publishedAt: Date | null;
  content: string | null;
  canonicalUrl: string | null;
  url: string | null;
}

/**
 * 选当日 KB 入库候选：push success（event / 今日）且非 tombstone 的 event。
 *
 * 候选单一口径（5.2 / design D7）：`push_records.status='success'` AND `target_type='event'`
 * AND `push_date=今日` AND `ai_news_events.merged_into IS NULL`。channel-blind（任一 channel
 * success 即算已推送；用 DISTINCT event_id 去重，避免多 channel 重复入候选）。
 *
 * 经 representative_raw_item_id LEFT JOIN 回指代表 raw_item 的 content/canonical_url（供 Agent 提取
 * 实体/source_urls 与构造 embedding 文本兜底）。
 */
async function selectCandidates(
  dbh: DbLike,
  pushDate: string,
  targetType: TargetType,
): Promise<KbCandidateEvent[]> {
  // 当日 push success 的 event_id 集合（channel-blind、DISTINCT 去重）。
  const successRows = await dbh
    .selectDistinct({ targetId: pushRecords.targetId })
    .from(pushRecords)
    .where(
      and(
        eq(pushRecords.targetType, targetType),
        eq(pushRecords.status, 'success'),
        eq(pushRecords.pushDate, pushDate),
      ),
    );

  const successEventIds = successRows.map((r) => r.targetId);
  if (successEventIds.length === 0) return [];

  // 经 event_id 取非 tombstone 事件 + LEFT JOIN 代表 raw_item content/canonical_url/url。
  const rows = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      summaryZh: aiNewsEvents.summaryZh,
      publishedAt: aiNewsEvents.publishedAt,
      content: rawItems.content,
      canonicalUrl: rawItems.canonicalUrl,
      url: rawItems.url,
    })
    .from(aiNewsEvents)
    .leftJoin(rawItems, eq(aiNewsEvents.representativeRawItemId, rawItems.id))
    .where(
      and(
        inArray(aiNewsEvents.eventId, successEventIds),
        // tombstone 排除（合并核心闭环）：被吞事件不进 KB 候选、不产生 kb_documents。
        isNull(aiNewsEvents.mergedInto),
      ),
    );

  return rows;
}

/** 把候选事件已知的 URL 收敛为 source_urls 候选（去重、去空），供 Agent 参考。 */
function knownSourceUrls(event: KbCandidateEvent): string[] {
  const set = new Set<string>();
  for (const u of [event.canonicalUrl, event.url]) {
    if (typeof u === 'string' && u.trim().length > 0) set.add(u.trim());
  }
  return [...set];
}

/** 把 event_date 推导为 YYYY-MM-DD：取 published_at（Asia/Shanghai 自然日），缺失回退今日 pushDate。 */
function deriveEventDate(event: KbCandidateEvent, pushDate: string): string {
  if (event.publishedAt) {
    return getPushDate(event.publishedAt);
  }
  return pushDate;
}

/**
 * 执行一轮知识库入库（供组 F 在 push 之后调用）。
 *
 * 对每条候选：KB Agent 产元数据（失败跳过）→ 准入闸 >= 70（不达跳过）→ embedding（失败降级 null）
 * → 状态感知认领 + 两表原子入库。任何 Agent/embed/写入失败一律隔离该条、不抛断整批、不污染 KB。
 *
 * @param options 含 now（决定候选 push_date）/ agent / embed / store / kbProvider 等可注入项。
 * @param dbh db 或事务句柄（默认全局 db）。storeKbDocument 内部自起事务，dbh 应为顶层 db 实例。
 */
export async function runKbIngestion(
  options: RunKbIngestionOptions = {},
  dbh: DbLike = defaultDb,
): Promise<KbIngestionResult> {
  const pushDate = getPushDate(options.now);
  const kbProvider = options.kbProvider ?? KB_PROVIDER_CUSTOM;
  const targetType = options.targetType ?? TARGET_TYPE.event;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[kb-ingestion] ${message}`, detail));

  const candidateEvents = await selectCandidates(dbh, pushDate, targetType);
  const result: KbIngestionResult = {
    candidates: candidateEvents.length,
    agentOk: 0,
    agentFailed: 0,
    gatedOut: 0,
    ingested: 0,
    skippedClaimed: 0,
    storeFailed: 0,
  };

  for (const event of candidateEvents) {
    // 1. KB Agent 产元数据（外部 LLM 调用，带重试；失败 → 跳过该条不入库、不中止整批）。
    let metadata;
    try {
      metadata = await generateKbMetadata(
        {
          representativeTitle: event.representativeTitle ?? '',
          summaryZh: event.summaryZh,
          content: event.content,
          sourceUrls: knownSourceUrls(event),
        },
        options.agent,
      );
      result.agentOk += 1;
    } catch (error) {
      result.agentFailed += 1;
      logError('知识摘要 Agent 失败/校验不过，跳过该候选不入库（不中止整批）', {
        eventId: event.eventId,
        error,
      });
      continue;
    }

    // 2. 准入闸（程序判定，非 LLM）：仅 long_term_value >= 70 入库。
    if (metadata.long_term_value < KB_ADMISSION_FLOOR) {
      result.gatedOut += 1;
      logError('候选未达准入阈（long_term_value < 70），不写入知识库', {
        eventId: event.eventId,
        longTermValue: metadata.long_term_value,
      });
      continue;
    }

    // 3. embedding（对 kb_title + summary_zh）：失败降级 null（列可空，不阻断入库）。
    let embedding: number[] | null = null;
    const embedText = `${metadata.kb_title}\n${metadata.summary_zh}`.trim();
    if (embedText.length > 0) {
      try {
        const vecs = await embedTexts([embedText], options.embed);
        embedding = vecs[0] ?? null;
      } catch (error) {
        logError('kb_documents embedding 生成失败，降级为 null（不阻断入库，列可空）', {
          eventId: event.eventId,
          error,
        });
        embedding = null;
      }
    }

    // 4. 状态感知认领 + 两表原子入库。
    const outcome = await storeKbDocument(
      {
        targetType,
        targetId: event.eventId,
        kbTitle: metadata.kb_title,
        summaryZh: metadata.summary_zh,
        tags: metadata.tags,
        entities: metadata.entities,
        // source_urls 取 Agent 产出 ∪ 候选已知 URL（去重、去空），保证可点击来源不丢。
        sourceUrls: mergeSourceUrls(metadata.source_urls, knownSourceUrls(event)),
        eventDate: metadata.event_date || deriveEventDate(event, pushDate),
        longTermValue: metadata.long_term_value,
        embedding,
      },
      { ...options.store, kbProvider },
      dbh,
    );

    if (outcome.outcome === 'ingested') {
      result.ingested += 1;
    } else if (outcome.outcome === 'skipped-claimed') {
      result.skippedClaimed += 1;
    } else {
      result.storeFailed += 1;
    }
  }

  return result;
}

/** 合并 Agent 产出与候选已知的 source_urls（去重、去空、保序：先 Agent 后已知）。 */
function mergeSourceUrls(
  agentUrls: readonly string[],
  knownUrls: readonly string[],
): string[] {
  const set = new Set<string>();
  for (const u of [...agentUrls, ...knownUrls]) {
    if (typeof u === 'string' && u.trim().length > 0) set.add(u.trim());
  }
  return [...set];
}
