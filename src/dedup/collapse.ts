/**
 * 硬去重塌缩落库（dedup-and-normalization，design D1/D2/D3）。
 *
 * 把一条已规范化的 raw_item 塌缩进 ai_news_events：
 *   `INSERT ... ON CONFLICT (dedup_key) DO UPDATE`
 *
 * 不变量（绝不可违背）：
 * - INSERT **省略 event_id**：由 DB 默认 `gen_random_uuid()::text` 生成不透明身份。
 * - 首建写 representative_raw_item_id / representative_title（取代表 raw_item 的**原始 title**，
 *   非归一化，保证 NOT NULL 可读）/ first_seen_at / published_at，初始化 source_count=1。
 * - ON CONFLICT DO UPDATE 的 set **只含** source_count（累加）与 last_seen_at（更新），
 *   绝不覆盖 event_id / representative_raw_item_id / representative_title /
 *   first_seen_at / published_at（P0 persistEventScores 全列覆盖式 set 是反面模板）。
 * - unprocessable raw_item（无 canonical_url 且归一后标题为空）不产生 event，
 *   仅把 raw_items.unprocessable 置 true。
 * - 去重判定全程程序 + DB 唯一约束，本期仅硬去重，无 embedding/LLM。
 */
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, rawItems } from '../db/schema.js';
import { normalizeRawItem, NORMALIZER_VERSION } from './normalize.js';

/** 塌缩所需的最小 raw_item 视图（由 collector 落库后读出，或集成测 seed）。 */
export interface RawItemForCollapse {
  /** raw_items.id（BIGINT），作 representative_raw_item_id。 */
  id: bigint;
  /** 原始 url，用于生成 canonical_url。 */
  url?: string | null;
  /** 原始 title（NOT NULL），既用于归一化，也作 representative_title 原文。 */
  title: string;
  /** 发布时间，写入 event.published_at。 */
  publishedAt?: Date | null;
  /** raw_items 入库时间（raw_items.fetched_at NOT NULL，恒有值），作首建 event.first_seen_at。 */
  fetchedAt: Date;
}

/** 单条塌缩结果（供调用方统计/可观测）。 */
export interface CollapseOutcome {
  rawItemId: bigint;
  /** 该条目所属事件的 dedup_key；unprocessable 时为 null。 */
  dedupKey: string | null;
  /** true=本条标记 unprocessable 未入 event；false=已塌缩进某 event。 */
  unprocessable: boolean;
}

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 事务句柄类型（DbLike.transaction 回调的入参），供事务内的写函数复用。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/**
 * 把规范化产物回写到 raw_items（canonical_url / title_hash / unprocessable +
 * metadata.normalizer_version）。与塌缩同批执行（规范化产物的回写，不另起阶段）。
 */
async function writeNormalizationBack(
  dbh: DbLike,
  rawItemId: bigint,
  fields: {
    canonicalUrl: string | null;
    titleHash: string | null;
    unprocessable: boolean;
  },
): Promise<void> {
  // 版本号片段作为参数化 jsonb 绑定，避免字符串拼接注入。
  const versionPatch = JSON.stringify({ normalizer_version: NORMALIZER_VERSION });
  await dbh
    .update(rawItems)
    .set({
      canonicalUrl: fields.canonicalUrl,
      titleHash: fields.titleHash,
      unprocessable: fields.unprocessable,
      // metadata 合并写入 normalizer_version（保留既有键），版本化可追溯（design D4）。
      metadata: sql`COALESCE(${rawItems.metadata}, '{}'::jsonb) || ${versionPatch}::jsonb`,
    })
    .where(eq(rawItems.id, rawItemId));
}

/**
 * 塌缩单条 raw_item 进 ai_news_events。
 *
 * 流程：
 * 1. 规范化（纯函数）得 canonical_url / title_hash / dedup_key / unprocessable。
 * 2. 回写 raw_items（canonical_url / title_hash / unprocessable / metadata.normalizer_version）。
 * 3. unprocessable → 不产生 event，返回。
 * 4. 否则 `INSERT ... ON CONFLICT (dedup_key) DO UPDATE`：
 *    - INSERT 省略 event_id（DB 生成），首建身份/代表/时间列、source_count=1；
 *    - 冲突时 set 只累加 source_count、更新 last_seen_at。
 * 5. 无论可处理与否，最后把 raw_items.collapsed 置 true（幂等标记）：
 *    塌缩对每条 raw_item 只贡献一次 source_count；崩溃重跑安全（已 collapsed 的不再扫到），
 *    unprocessable 的也标记处理过、不会每轮被重复扫（Codex C1）。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function collapseRawItem(
  item: RawItemForCollapse,
  dbh: DbLike = defaultDb,
): Promise<CollapseOutcome> {
  const norm = normalizeRawItem({ url: item.url, title: item.title });

  await writeNormalizationBack(dbh, item.id, {
    canonicalUrl: norm.canonicalUrl,
    titleHash: norm.titleHash,
    unprocessable: norm.unprocessable,
  });

  if (norm.unprocessable || norm.dedupKey === null) {
    // unprocessable 也标记 collapsed=true：使其不再被 collapseUncollapsedRawItems 重复扫到。
    await markCollapsed(dbh, item.id);
    return { rawItemId: item.id, dedupKey: null, unprocessable: true };
  }

  const now = new Date();

  // 「INSERT/ON CONFLICT 塌缩」+「markCollapsed 该 raw_item」必须原子提交（同一事务）：
  // 否则崩在二者之间 → 下轮 collapseUncollapsedRawItems 重扫到该 raw_item（collapsed 仍 false）
  // → source_count 再 +1，违反「每 raw_item 恰好贡献一次」。崩在中间整体回滚，下轮重做仍只累加一次。
  // dbh 可能本身已是事务句柄；drizzle 的 tx.transaction() 会以 savepoint 嵌套，安全复用。
  await dbh.transaction(async (tx) => {
    await tx
      .insert(aiNewsEvents)
      .values({
        // event_id 省略 → DB 默认 gen_random_uuid()::text 生成不透明身份（design D1）。
        dedupKey: norm.dedupKey,
        representativeRawItemId: item.id,
        // 代表 title 取**原始** title（非归一化），保证 NOT NULL 可读（spec / design D2）。
        representativeTitle: item.title,
        // first_seen 用 raw_item 实际入库时间（崩溃残留/延迟旧条目补塌缩时不被误标为「刚首见」）。
        firstSeenAt: item.fetchedAt,
        lastSeenAt: now,
        publishedAt: item.publishedAt ?? null,
        sourceCount: 1,
      })
      .onConflictDoUpdate({
        target: aiNewsEvents.dedupKey,
        // set 只累加 source_count、更新 last_seen_at——绝不覆盖身份/代表/时间列（design D1）。
        set: {
          sourceCount: sql`${aiNewsEvents.sourceCount} + 1`,
          lastSeenAt: now,
        },
      });

    // 塌缩成功后把该 raw_item 置 collapsed=true：source_count 贡献恰好一次（幂等，design D1）。
    await markCollapsed(tx, item.id);
  });

  return { rawItemId: item.id, dedupKey: norm.dedupKey, unprocessable: false };
}

/** 把单条 raw_item 标记为已塌缩（collapsed=true），使其不再被塌缩入口扫到（幂等标记）。 */
async function markCollapsed(dbh: DbLike | TxLike, rawItemId: bigint): Promise<void> {
  await dbh
    .update(rawItems)
    .set({ collapsed: true })
    .where(eq(rawItems.id, rawItemId));
}

/**
 * 批量塌缩：顺序处理（塌缩是写操作且依赖唯一键冲突语义，顺序执行避免同批自冲突竞态）。
 * 返回每条结果，供上层统计「可处理条目数」（含塌缩进既有事件者）与 unprocessable 数。
 */
export async function collapseRawItems(
  items: readonly RawItemForCollapse[],
  dbh: DbLike = defaultDb,
): Promise<CollapseOutcome[]> {
  const outcomes: CollapseOutcome[] = [];
  for (const item of items) {
    outcomes.push(await collapseRawItem(item, dbh));
  }
  return outcomes;
}

/**
 * 塌缩入口（编排层应调用此函数，取代「按本轮 insertedIds 塌缩」的脆弱依赖，Codex C1）。
 *
 * 扫出库内**所有** `unprocessable=false AND collapsed=false` 且**新闻类**的 raw_items 逐条塌缩——
 * 不依赖外部传入的 id 列表，故：
 * - 全重复日（insertedIds=0）：若上轮已塌缩则这些行 collapsed=true 不再扫到，正常无新增、不误告警；
 * - 崩溃后补塌缩：INSERT 成功但塌缩前崩溃的 raw_item collapsed 仍为 false，下次必被扫到补塌缩
 *   （即便其 source_item_id 重复导致再次入库被 DO NOTHING 跳过、不在 insertedIds）。
 *
 * **类型路由（P2，dedup-and-normalization MODIFIED）**：查询层排除 `raw_type='product'`（PH）与
 * `raw_type='paper'`（arXiv），防产品/论文条目污染新闻事件流或被双重消费。排除条件用
 * **`raw_type IS DISTINCT FROM 'product' AND raw_type IS DISTINCT FROM 'paper'`**（而非 NOT IN）：
 * `raw_type` 列可空，`NULL NOT IN (...)` 求值为 NULL 会**放行** NULL 行；`IS DISTINCT FROM` 使
 * NULL 被当作新闻类纳入塌缩，保持 P1「news/repo/post/NULL 等其余值一律进事件流」行为不回退。
 * 产品行由产品塌缩成功后置 collapsed=true；论文行入库即置 collapsed=true（仅沉淀、无下游消费），
 * 故被排除的 product/paper 行不停在 collapsed=false 被每轮无界重扫。
 *
 * 每条塌缩后置 collapsed=true（见 collapseRawItem），故 source_count 贡献恰好一次（幂等）。
 * 顺序处理（塌缩依赖 dedup_key 唯一键冲突语义，顺序执行避免同批自冲突竞态）。
 *
 * 返回每条结果，供上层统计「可处理条目数」（含塌缩进既有事件者）与 unprocessable 数。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function collapseUncollapsedRawItems(
  dbh: DbLike = defaultDb,
): Promise<CollapseOutcome[]> {
  // 选出尚未塌缩、未被前一轮标记 unprocessable、且为**新闻类**的 raw_items（id 升序，先到先建代表）。
  // 类型路由（P2）：用 IS DISTINCT FROM 排除 product/paper，NULL raw_type 视作新闻纳入（保 P1 行为）。
  const pending = await dbh
    .select({
      id: rawItems.id,
      url: rawItems.url,
      title: rawItems.title,
      publishedAt: rawItems.publishedAt,
      fetchedAt: rawItems.fetchedAt,
    })
    .from(rawItems)
    .where(
      and(
        eq(rawItems.unprocessable, false),
        eq(rawItems.collapsed, false),
        sql`${rawItems.rawType} IS DISTINCT FROM 'product'`,
        sql`${rawItems.rawType} IS DISTINCT FROM 'paper'`,
      ),
    )
    .orderBy(rawItems.id);

  const items: RawItemForCollapse[] = pending.map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
  }));
  return collapseRawItems(items, dbh);
}
