/**
 * 确定性事件合并（add-semantic-dedup-and-store-hardening，组 D 任务 4.4，spec「确定性事件合并」/
 * design D5）。
 *
 * 职责：语义层判定两事件同一时，由**程序 + DB 单事务**执行合并（绝不交给 LLM）。
 *
 * 关键不变量（绝不可违背，spec / design D5，逐条守住）：
 * - **存活者 = `first_seen_at` 较早者**（并列取 `event_id` 字典序小者），吞并较新者。
 * - **单事务 + 两行 `FOR UPDATE` 按 `event_id` 字典序升序加锁**（防 AB-BA 死锁纵深防御）。
 * - **链式合并解析到终态存活者**：任何「据 `merged_into` 找存活者」必须沿链递归/迭代到终态
 *   （`merged_into IS NULL`），带**环路保护**（已访问集合，命中环报错告警），绝不停在仍是 tombstone
 *   的中间行、绝不无限循环。新合并时存活/被吞两侧都先解析到各自终态行。
 * - 存活者**一次性** `source_count += 被吞 source_count`（被吞 tombstone 的 source_count 此后冻结，
 *   塌缩改投只对真正新到的 raw_item +1、不重加）；`published_at = COALESCE(存活, 被吞)`（单向 NULL-fill）；
 *   `first_seen_at = LEAST(...)`；`last_seen_at = GREATEST(...)`。
 * - **冻结**存活者 `event_id` / `representative_raw_item_id` / `representative_title` / `dedup_key`。
 * - 被吞事件**不物理删除**，置 `merged_into = 存活 event_id`（tombstone），保留 dedup_key 唯一占位。
 * - **合并 provenance**：记录被吞/存活 `event_id`、`cosine_sim`、触发档位（`high-auto`/`llm-confirmed`）、
 *   LLM `reason`（若经 LLM）到可观测日志/轻量审计，使误并可审计可回滚（spec「偏离登记 + 风险闸」②）。
 *
 * **并发**：语义合并仅在日报链单例锁内执行（合并-合并不并发）；FOR UPDATE 锁序是纵深防御。
 * 合并 vs 塌缩并发的串行化由 collapse 改投侧靠同一 dedup_key 行锁保证（见 collapse.ts），本模块对
 * 被吞行 FOR UPDATE 即参与该串行化。
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents } from '../db/schema.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;
/** 事务句柄类型（DbLike.transaction 回调入参）。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/** 合并触发档位（provenance）。 */
export type MergeTier = 'high-auto' | 'llm-confirmed';

/** 单次合并的 provenance（记可观测日志/轻量审计，使误并可审计可回滚）。 */
export interface MergeProvenance {
  /** 存活者 event_id（链解析后的终态存活者）。 */
  survivorId: string;
  /** 被吞者 event_id（链解析后的终态行，被置 tombstone）。 */
  absorbedId: string;
  /** 触发该合并的余弦相似度（候选检索算出）。 */
  cosineSim: number;
  /** 触发档位：high-auto（>HIGH 直接合并）/ llm-confirmed（灰区经 LLM 判 same）。 */
  tier: MergeTier;
  /** LLM 判断理由（若经 LLM；high-auto 为 undefined）。 */
  reason?: string;
}

/** 合并结果（供编排统计/可观测）。 */
export interface MergeOutcome {
  /** 'merged' = 实际发生合并；'noop' = 解析后两侧同一终态行（已合并/同事件）无需再合并。 */
  status: 'merged' | 'noop';
  /** 存活者 event_id（status='merged' 时为终态存活者；'noop' 时为共同终态行）。 */
  survivorId: string;
  /** 被吞者 event_id（status='merged' 时为被置 tombstone 的终态行；'noop' 时为 null）。 */
  absorbedId: string | null;
}

export interface MergeEventsOptions {
  /** 触发该合并的余弦相似度（provenance）。 */
  cosineSim: number;
  /** 触发档位（provenance）。 */
  tier: MergeTier;
  /** LLM 判断理由（provenance，若经 LLM）。 */
  reason?: string;
  /**
   * provenance sink（默认 console.error）：记录每次合并的被吞/存活/相似度/档位/reason。
   * 测试可注入断言「合并被审计记录」。
   */
  logProvenance?: (provenance: MergeProvenance) => void;
}

/** 链解析过程中读取的一行最小视图。 */
interface ChainRow {
  eventId: string;
  mergedInto: string | null;
  firstSeenAt: Date | null;
}

/**
 * 沿 `merged_into` 链迭代解析到终态存活者（`merged_into IS NULL`），在**已加行锁的事务内**进行。
 *
 * - 带环路保护：已访问集合，命中环（理论不应发生）即抛错告警，绝不无限循环。
 * - 每跳都 `SELECT ... FOR UPDATE` 该行（锁定链上每一行，与并发塌缩/合并串行化）。
 * - 返回终态行（含 first_seen_at，供存活者比较）。
 *
 * @throws 链中断（指向不存在的 event_id）或检出环 → 抛错（由调用方在事务内冒泡回滚 + 告警）。
 */
async function resolveTerminalLocked(
  tx: TxLike,
  startId: string,
): Promise<ChainRow> {
  const visited = new Set<string>();
  let currentId = startId;
  // 链深有界（每跳指向更早合并者）；环路/断链保护使最坏 O(链长) 终止。
  for (;;) {
    if (visited.has(currentId)) {
      throw new Error(
        `merge-events: merged_into 链检出环路（已访问 ${currentId}），中止合并并告警——数据异常。`,
      );
    }
    visited.add(currentId);

    const rows = await tx
      .select({
        eventId: aiNewsEvents.eventId,
        mergedInto: aiNewsEvents.mergedInto,
        firstSeenAt: aiNewsEvents.firstSeenAt,
      })
      .from(aiNewsEvents)
      .where(sql`${aiNewsEvents.eventId} = ${currentId}`)
      .for('update');

    const row = rows[0];
    if (!row) {
      throw new Error(
        `merge-events: merged_into 链断裂（${currentId} 不存在），中止合并并告警——数据异常。`,
      );
    }
    if (row.mergedInto === null) {
      return { eventId: row.eventId, mergedInto: null, firstSeenAt: row.firstSeenAt };
    }
    currentId = row.mergedInto;
  }
}

/**
 * 选存活者：`first_seen_at` 较早者存活；并列（或任一为 NULL）取 `event_id` 字典序小者。
 *
 * NULL first_seen_at 视为「最晚」（排在有值之后）——塌缩首建恒写 first_seen_at，NULL 属异常行，
 * 让其优先被吞（保留有确定首见时间者为存活）。两者皆 NULL 时退化为 event_id 字典序。
 *
 * @returns `{ survivor, absorbed }` 两个终态行。
 */
function pickSurvivor(
  a: ChainRow,
  b: ChainRow,
): { survivor: ChainRow; absorbed: ChainRow } {
  const at = a.firstSeenAt ? a.firstSeenAt.getTime() : null;
  const bt = b.firstSeenAt ? b.firstSeenAt.getTime() : null;
  if (at !== bt) {
    if (at === null) return { survivor: b, absorbed: a }; // a NULL → a 被吞
    if (bt === null) return { survivor: a, absorbed: b }; // b NULL → b 被吞
    return at < bt ? { survivor: a, absorbed: b } : { survivor: b, absorbed: a };
  }
  // first_seen_at 相等（或同为 NULL）：event_id 字典序小者存活。
  return a.eventId < b.eventId
    ? { survivor: a, absorbed: b }
    : { survivor: b, absorbed: a };
}

/**
 * 合并两事件（确定性，程序 + DB 单事务）。
 *
 * 流程：
 * 1. 单事务内，按 `event_id` 字典序升序对**输入两 id** `FOR UPDATE`（防 AB-BA；锁序在 resolve 前先
 *    按输入 id 升序触锁，再各自链解析到终态）。
 * 2. 两侧各沿 merged_into 链解析到终态行（resolveTerminalLocked，链上每行 FOR UPDATE + 环路保护）。
 * 3. 终态两行若同一 → noop（已是同事件/已合并），不重复合并。
 * 4. 否则 pickSurvivor（first_seen 较早、并列 event_id 小者存活）；存活者一次性吸收被吞 source_count、
 *    COALESCE published_at、LEAST first_seen_at、GREATEST last_seen_at；被吞置 merged_into=存活。
 * 5. 记 provenance（被吞/存活/相似度/档位/reason）。
 *
 * @param idA / idB 判定为同一事件的两 event_id（任意序；内部按字典序加锁）。
 * @param options   provenance（cosineSim / tier / reason）+ logProvenance。
 * @param dbh       可注入 db 或事务句柄（默认全局 db）。
 */
export async function mergeEvents(
  idA: string,
  idB: string,
  options: MergeEventsOptions,
  dbh: DbLike = defaultDb,
): Promise<MergeOutcome> {
  const logProvenance =
    options.logProvenance ??
    ((p: MergeProvenance) =>
      console.error('[merge-events] 合并 provenance', p));

  // dbh 可能本身已是事务句柄；drizzle tx.transaction() 以 savepoint 嵌套，安全复用。
  const outcome = await dbh.transaction(async (tx) => {
    // 防 AB-BA 死锁纵深防御：按**输入两 id** 字典序升序先各触一次行锁，再链解析到终态。
    // （合并仅在日报单例锁内，合并-合并本不并发；此锁序是与塌缩并发/未来扩展的纵深防御。）
    const [firstId, secondId] = idA < idB ? [idA, idB] : [idB, idA];
    const firstTerminal = await resolveTerminalLocked(tx, firstId);
    const secondTerminal = await resolveTerminalLocked(tx, secondId);

    // 终态同一行 → 已是同事件/已被合并到一起，noop（绝不自合并）。
    if (firstTerminal.eventId === secondTerminal.eventId) {
      return {
        status: 'noop' as const,
        survivorId: firstTerminal.eventId,
        absorbedId: null,
      };
    }

    const { survivor, absorbed } = pickSurvivor(firstTerminal, secondTerminal);

    // 存活者一次性吸收被吞 source_count + COALESCE published_at + LEAST first_seen + GREATEST last_seen。
    // 冻结 event_id / representative_* / dedup_key（set 中不含这些列）。
    await tx
      .update(aiNewsEvents)
      .set({
        sourceCount: sql`COALESCE(${aiNewsEvents.sourceCount}, 0) + COALESCE((
          select ${aiNewsEvents.sourceCount} from ${aiNewsEvents} where ${aiNewsEvents.eventId} = ${absorbed.eventId}
        ), 0)`,
        publishedAt: sql`COALESCE(${aiNewsEvents.publishedAt}, (
          select ${aiNewsEvents.publishedAt} from ${aiNewsEvents} where ${aiNewsEvents.eventId} = ${absorbed.eventId}
        ))`,
        firstSeenAt: sql`LEAST(${aiNewsEvents.firstSeenAt}, (
          select ${aiNewsEvents.firstSeenAt} from ${aiNewsEvents} where ${aiNewsEvents.eventId} = ${absorbed.eventId}
        ))`,
        lastSeenAt: sql`GREATEST(${aiNewsEvents.lastSeenAt}, (
          select ${aiNewsEvents.lastSeenAt} from ${aiNewsEvents} where ${aiNewsEvents.eventId} = ${absorbed.eventId}
        ))`,
      })
      .where(sql`${aiNewsEvents.eventId} = ${survivor.eventId}`);

    // 被吞置 tombstone（merged_into = 存活 event_id），不物理删除、保留 dedup_key 唯一占位。
    await tx
      .update(aiNewsEvents)
      .set({ mergedInto: survivor.eventId })
      .where(sql`${aiNewsEvents.eventId} = ${absorbed.eventId}`);

    return {
      status: 'merged' as const,
      survivorId: survivor.eventId,
      absorbedId: absorbed.eventId,
    };
  });

  // 记 provenance（合并发生时）——被吞/存活/相似度/档位/reason，误并可审计可回滚。
  if (outcome.status === 'merged' && outcome.absorbedId !== null) {
    const provenance: MergeProvenance = {
      survivorId: outcome.survivorId,
      absorbedId: outcome.absorbedId,
      cosineSim: options.cosineSim,
      tier: options.tier,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    };
    logProvenance(provenance);
  }

  return outcome;
}
