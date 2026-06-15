/**
 * 本地表知识库入库（add-semantic-dedup-and-store-hardening，组 E / spec「本地表知识库存储」
 * +「知识库入库幂等」，design D7）。
 *
 * 职责：把一条经知识摘要 Agent 产出元数据、且过准入闸（`long_term_value >= 70`，由调用方
 * runKbIngestion 判定）的事件，**幂等且两表原子**地沉淀进本地表知识库。
 *
 * 关键不变量（逐条守住，spec / design D7；幂等完全靠程序 + DB，绝不交 LLM）：
 *
 * 1. **状态感知认领（claim CAS，在入库事务内）**：
 *    `INSERT kb_ingestion_records(status='pending') ON CONFLICT(target_type,target_id,kb_provider)
 *     DO UPDATE SET status='pending', ingested_at=now()
 *     WHERE kb_ingestion_records.status <> 'success' RETURNING id`
 *    - 已 `success` 者 `setWhere` 不满足 → RETURNING 空 → **跳过**（不重入，幂等闸 = success 终态只一次）。
 *    - 不存在 / `failed` / 僵尸 `pending` 者被认领为 `pending` 并返回 id → 继续入库（重试）。
 *    - **绝不可用 `DO NOTHING`**（否则一条 `failed` 行永久挡死该 event 的重试，与「失败可重试」矛盾，
 *      对齐 value-judge 的 claim CAS 范式，而非 dispatcher 的 DO NOTHING）。
 *
 * 2. **认领与两表写入同事务（DB 层即防重复 / 孤儿 kb_documents）**：`kb_documents` 自身无业务唯一
 *    约束。claim CAS + 「插 kb_documents（含 embedding）+ 置该 record status='success' + 回指
 *    kb_document_id」**全部在同一 DB 事务**内：claim 的 ON CONFLICT 在 tx 内对冲突行**持行锁直到提交**，
 *    使并发认领被该行锁串行化——A 提交 success 后，B 的 claim 因 `status='success'`（setWhere 不满足）
 *    命中 0 行而跳过，故 DB 层即保证不产生重复 / 孤儿 kb_documents（不依赖外部单例锁）。任一步失败 →
 *    事务回滚（**不留 kb_documents**，且 claim 写入的 pending 一并回滚）→ 再以 **UPSERT**
 *    （`INSERT ... ON CONFLICT DO UPDATE SET status='failed' WHERE status<>'success'`）置 `failed`
 *    保留 `error_message`（行可能已随回滚消失，故不能按 id 裸 UPDATE；下次认领因 status='failed'
 *    重新抢到重试；因失败已回滚故无残留文档，重试不产生重复）。
 *
 * 3. **崩溃残留**：若崩溃发生在「事务回滚之后、UPSERT 置 failed 之前」，该行恢复到回滚后的状态
 *    （新建场景下行不存在；既有 failed/pending 场景下保留原状态），均由下次认领的 `status<>'success'`
 *    重新抢到重试，无正确性损失（回滚已确保无残留文档）。
 *
 * 单例锁：KB 入库阶段虽运行在日报链单例锁内，但去重复 / 防孤儿的保证由「认领 + 两表同事务（行锁
 * 串行化并发认领）」在 DB 层独立给出，单例锁是额外纵深防御、非唯一保证。
 */
import { eq, ne, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { kbDocuments, kbIngestionRecords } from '../db/schema.js';
import { TARGET_TYPE, type TargetType } from '../push/targets.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 事务句柄类型（DbLike.transaction 回调入参），使 claimRecord 可在事务内复用（行锁保持到提交）。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/** 本地表知识库 provider 取值（指向 kb_documents 本地表，design D7）。 */
export const KB_PROVIDER_CUSTOM = 'custom';

/** record 状态机取值（仅本地表入库用到 pending/success/failed 三态）。 */
const STATUS_PENDING = 'pending';
const STATUS_SUCCESS = 'success';
const STATUS_FAILED = 'failed';

/** 入库一条事件所需的全部已校验数据（元数据 + embedding + 目标四元组的 target 部分）。 */
export interface KbStoreItem {
  /** 目标实体类型（本期仅 event）。 */
  targetType: TargetType;
  /** 目标实体标识（event_id）。 */
  targetId: string;
  /** 知识摘要 Agent 产出的元数据。 */
  kbTitle: string;
  summaryZh: string;
  tags: string[];
  entities: string[];
  sourceUrls: string[];
  /** YYYY-MM-DD 字符串（写入 kb_documents.event_date / date 列）。 */
  eventDate: string;
  /** 长期价值分（已过准入闸 >= 70；全量值落库供审计）。 */
  longTermValue: number;
  /** 知识库检索 embedding（可空；失败/未生成时为 null，不阻断入库）。 */
  embedding: number[] | null;
}

/** 单条入库结果（供编排/可观测）。 */
export type KbStoreOutcome =
  /** 认领并两表原子写入成功，新增恰一条 kb_documents。 */
  | { outcome: 'ingested'; kbDocumentId: string }
  /** 认领未抢到（已 success）→ 跳过，不产生重复。 */
  | { outcome: 'skipped-claimed' }
  /** 认领成功但写入阶段失败 → 已回滚（无残留文档）+ 独立置 failed（下次可重试）。 */
  | { outcome: 'failed'; error: string };

export interface KbStoreOptions {
  /** kb_provider，默认 'custom'（本地表）。 */
  kbProvider?: string;
  /** 错误日志 sink，默认 console.error；便于测试断言（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
}

/**
 * 状态感知认领：`INSERT(pending) ON CONFLICT DO UPDATE SET status='pending', ingested_at=now()
 * WHERE status<>'success' RETURNING id`。
 *
 * @returns 认领成功返回 record id（bigint）；已 success（setWhere 不满足、RETURNING 空）返回 null。
 */
async function claimRecord(
  dbh: DbLike | TxLike,
  targetType: TargetType,
  targetId: string,
  kbProvider: string,
): Promise<bigint | null> {
  const claimed = await dbh
    .insert(kbIngestionRecords)
    .values({
      targetType,
      targetId,
      kbProvider,
      status: STATUS_PENDING,
      ingestedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [
        kbIngestionRecords.targetType,
        kbIngestionRecords.targetId,
        kbIngestionRecords.kbProvider,
      ],
      set: {
        status: STATUS_PENDING,
        ingestedAt: sql`now()`,
      },
      // ⚠️ 状态感知守卫：已 success 的行不更新、RETURNING 不返回该行 → 跳过（不重入）。
      // failed / 僵尸 pending（status<>'success'）被重新抢到 → RETURNING 返回 → 重试。
      // **绝不可**改成 DO NOTHING（否则 failed 永久挡死重试，spec 明文禁止）。
      setWhere: ne(kbIngestionRecords.status, STATUS_SUCCESS),
    })
    .returning({ id: kbIngestionRecords.id });

  return claimed.length > 0 ? claimed[0]!.id : null;
}

/**
 * 把一条已校验、已过准入闸的事件幂等且两表原子地写入本地表知识库。
 *
 * 流程（认领与两表写入同事务，claim 行锁串行化并发认领，详见文件头不变量 1/2/3）：
 * 1. 同一事务内状态感知认领（claimRecord）：已 success → 返回 `skipped-claimed`，不入库。
 * 2. 认领成功 → 同事务续：插 kb_documents（含 embedding）→ 置 record status='success' + 回指
 *    kb_document_id。事务提交 → `ingested`。
 * 3. 事务任一步失败 → 自动回滚（不留 kb_documents，claim 写入的 pending 一并回滚）→ 以 UPSERT 置
 *    status='failed' 保留 error_message → 返回 `failed`（下次认领据 status='failed' 重新抢到重试，无残留文档）。
 *
 * **绝不抛断整批**：认领跳过 / 写入失败均以 KbStoreOutcome 返回，由调用方继续处理其余候选。
 *
 * @param dbh db 句柄（默认全局 db）。本函数内部自起事务，dbh 应为顶层 db 实例（须支持 transaction）。
 */
export async function storeKbDocument(
  item: KbStoreItem,
  options: KbStoreOptions = {},
  dbh: DbLike = defaultDb,
): Promise<KbStoreOutcome> {
  const kbProvider = options.kbProvider ?? KB_PROVIDER_CUSTOM;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[kb-store] ${message}`, detail));

  // 认领 + 两表写入在**同一事务**：claim CAS（ON CONFLICT DO UPDATE ... WHERE status<>'success'
  // RETURNING）在 tx 内对冲突行持行锁，并保持到 kb_documents 插入 + 置 success 提交——并发认领被该行锁
  // 串行化（A 提交 success 后，B 的 claim 因 status='success' 命中 0 行而跳过），DB 层即保证不产生重复/
  // 孤儿 kb_documents（不依赖外部单例锁；单例锁是额外纵深）。
  try {
    const result = await dbh.transaction(
      async (tx): Promise<KbStoreOutcome> => {
        const recordId = await claimRecord(
          tx,
          item.targetType,
          item.targetId,
          kbProvider,
        );
        if (recordId === null) {
          // 已 success → 跳过（幂等闸命中），不插 kb_documents。
          return { outcome: 'skipped-claimed' };
        }
        const inserted = await tx
          .insert(kbDocuments)
          .values({
            targetType: item.targetType,
            targetId: item.targetId,
            kbTitle: item.kbTitle,
            summaryZh: item.summaryZh,
            tags: item.tags,
            entities: item.entities,
            sourceUrls: item.sourceUrls,
            eventDate: item.eventDate,
            longTermValue: item.longTermValue,
            embedding: item.embedding ?? null,
          })
          .returning({ id: kbDocuments.id });
        const docId = inserted[0]!.id;
        await tx
          .update(kbIngestionRecords)
          .set({
            status: STATUS_SUCCESS,
            kbDocumentId: String(docId),
            ingestedAt: sql`now()`,
            errorMessage: null,
          })
          .where(eq(kbIngestionRecords.id, recordId));
        return { outcome: 'ingested', kbDocumentId: String(docId) };
      },
    );
    return result;
  } catch (error) {
    // 事务回滚（claim 写入的 pending 也随之回滚：新行消失 / 既有行恢复原状态）→ 以 UPSERT 置 failed
    // （按 id 裸 UPDATE 会因行可能已消失而落空，故用 INSERT ... ON CONFLICT DO UPDATE）。
    // setWhere ne(success) 防覆盖已 success 终态（纵深防御）。下次认领据 status='failed' 重新抢到重试，
    // 因失败已回滚故无残留文档，重试不产生重复。
    const message = error instanceof Error ? error.message : String(error);
    logError('kb_documents 写入事务失败，已回滚（无残留文档），置 record failed 供重试', {
      targetType: item.targetType,
      targetId: item.targetId,
      kbProvider,
      error,
    });
    try {
      await dbh
        .insert(kbIngestionRecords)
        .values({
          targetType: item.targetType,
          targetId: item.targetId,
          kbProvider,
          status: STATUS_FAILED,
          errorMessage: message.slice(0, 1000),
          ingestedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [
            kbIngestionRecords.targetType,
            kbIngestionRecords.targetId,
            kbIngestionRecords.kbProvider,
          ],
          set: {
            status: STATUS_FAILED,
            errorMessage: message.slice(0, 1000),
            ingestedAt: sql`now()`,
          },
          setWhere: ne(kbIngestionRecords.status, STATUS_SUCCESS),
        });
    } catch (markErr) {
      logError('置 record failed（upsert）失败，下次认领回收重试，无残留文档', {
        targetType: item.targetType,
        targetId: item.targetId,
        kbProvider,
        error: markErr,
      });
    }
    return { outcome: 'failed', error: message };
  }
}

export { TARGET_TYPE };
