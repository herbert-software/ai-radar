/**
 * 统一入库（任务 4.4，source-collectors）。
 *
 * 把 collector 产出的统一 `CollectedItem` 写入 raw_items：
 *   `INSERT ... ON CONFLICT (source, source_item_id) DO NOTHING`
 *
 * 不变量（绝不可违背）：
 * - 入库时**即时生成** canonical_url 与 title_hash（复用 dedup/normalize.ts 纯函数），
 *   collector 只产业务字段，规范化在此一处落实（design D4：P1 必须真正填 canonical_url）。
 * - 源内幂等由 `UNIQUE(source, source_item_id)` + ON CONFLICT DO NOTHING 保障：
 *   同一源重复抓取同一条目，第二次写入冲突被跳过，raw_items 中该源该条目仅一行。
 * - source_item_id **绝不为 NULL**：collector fallback 链已保证；本层再兜底校验一次，
 *   缺失则跳过该条 + 记错误日志（绝不写 NULL 致 UNIQUE(source, NULL) 放行多行）。
 * - normalizer_version 写入 metadata，与 collector 携带的 metadata 合并（design D4）。
 *
 * 去重判定全程程序 + DB 唯一约束，本层无 embedding/LLM。
 * 塌缩成 event 是下游（dedup/collapse.ts）职责，不在本层。
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { rawItems } from '../db/schema.js';
import {
  computeTitleHash,
  normalizeUrl,
  NORMALIZER_VERSION,
} from '../dedup/normalize.js';
import { defaultLogError, type CollectedItem, type LogError } from './types.js';

type DbLike = typeof defaultDb;

export interface StoreOptions {
  /** 可注入 db 或事务句柄（默认全局 db）。 */
  dbh?: DbLike | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
}

export interface StoreResult {
  /** 收到待入库的条目总数。 */
  received: number;
  /** 实际尝试 INSERT 的条目数（已过滤掉 source_item_id 缺失者）。 */
  attempted: number;
  /** 因 source_item_id 缺失被跳过的条目数。 */
  skippedInvalid: number;
  /** 成功新插入的行数（冲突跳过的不计入）。 */
  inserted: number;
  /**
   * 本轮**真正新插入**的 raw_items 行 id（源内冲突跳过者不在内）。
   * Wave2a 起塌缩改由 collapseUncollapsedRawItems（按 collapsed 标记驱动）负责，
   * 不再据此选条；本字段暂保留供可观测，Wave2b 调整 run-daily 用法后再定去留。
   */
  insertedIds: bigint[];
  /**
   * 本轮采集**返回**的条目中「可处理」的数量——即归一化后能构造 canonical_url 或 title_hash
   * （非 unprocessable）的条数，**含**会塌缩进既有事件的源内重复项（冲突跳过者也计入）。
   *
   * 取代 insertedIds 作为「全 unprocessable」系统级告警的判定依据（Codex C1 (a)）：
   * 全重复日 insertedIds=0 但 processableCount>0 → 是正常无新闻日、不应误判全 unprocessable 告警。
   */
  processableCount: number;
}

/**
 * 把统一结构条目批量写入 raw_items（源内幂等）。
 *
 * 逐条 INSERT ... ON CONFLICT DO NOTHING ... RETURNING id：RETURNING 在冲突跳过时返回空，
 * 据此精确统计「真正新插入」的行数（与「源内重复被跳过」区分，供可观测）。
 */
export async function storeCollectedItems(
  items: readonly CollectedItem[],
  options: StoreOptions = {},
): Promise<StoreResult> {
  const dbh = options.dbh ?? defaultDb;
  const logError = options.logError ?? defaultLogError;

  let attempted = 0;
  let skippedInvalid = 0;
  let inserted = 0;
  let processableCount = 0;
  const insertedIds: bigint[] = [];

  for (const item of items) {
    // 兜底校验：source_item_id 绝不为 NULL/空串。collector fallback 链已保证，
    // 这里是「程序保事实」的最后一道闸——宁可跳过并告警，也绝不写空标识。
    const sourceItemId = item.sourceItemId?.trim();
    if (!sourceItemId) {
      skippedInvalid += 1;
      logError('source_item_id 缺失，跳过入库（绝不写 NULL 标识）', {
        source: item.source,
        title: item.title,
      });
      continue;
    }

    // 入库时即时生成 canonical_url / title_hash（复用规范化纯函数）。
    const canonicalUrl = normalizeUrl(item.url);
    const titleHash = computeTitleHash(item.title);

    // 可处理 = 能构造 canonical_url 或 title_hash（非 unprocessable）。与塌缩侧 unprocessable
    // 判定同口径（无 canonical_url 且归一后标题为空 → 两者皆 null）。源内重复项也计入：
    // 它会塌缩进既有事件、贡献 source_count，属可处理范畴（Codex C1 (a)）。
    if (canonicalUrl !== null || titleHash !== null) {
      processableCount += 1;
    }

    const metadata = JSON.stringify({
      ...(item.metadata ?? {}),
      normalizer_version: NORMALIZER_VERSION,
    });

    attempted += 1;

    const rows = await dbh
      .insert(rawItems)
      .values({
        source: item.source,
        sourceItemId,
        rawType: item.rawType,
        url: item.url,
        canonicalUrl,
        title: item.title,
        titleHash,
        content: item.content,
        publishedAt: item.publishedAt,
        metadata: sql`${metadata}::jsonb`,
      })
      // 源内幂等：UNIQUE(source, source_item_id) 冲突即跳过（不更新，保留首条）。
      .onConflictDoNothing({
        target: [rawItems.source, rawItems.sourceItemId],
      })
      .returning({ id: rawItems.id });

    if (rows.length > 0) {
      inserted += 1;
      insertedIds.push(rows[0]!.id);
    }
  }

  return {
    received: items.length,
    attempted,
    skippedInvalid,
    inserted,
    insertedIds,
    processableCount,
  };
}
