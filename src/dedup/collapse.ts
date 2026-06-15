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
 * - ON CONFLICT DO UPDATE 的 set 累加 source_count、更新 last_seen_at，并对 published_at 做
 *   `COALESCE(published_at, EXCLUDED.published_at)` 单向 NULL-fill（仅 NULL→已知补值，已设值
 *   绝不被覆盖——确定性事实优先于 AI 推断，design D8）；event_id / representative_raw_item_id /
 *   representative_title / first_seen_at 仍冻结、绝不覆盖（P0 persistEventScores 全列覆盖式 set
 *   是反面模板）。
 * - unprocessable raw_item（无 canonical_url 且归一后标题为空）不产生 event，
 *   仅把 raw_items.unprocessable 置 true。
 * - 去重判定全程程序 + DB 唯一约束（硬去重层）；P3 起 embedding/LLM 语义合并由 semantic-dedup
 *   承接（塌缩之后、value-judge 之前），其落库仍由程序 + DB 单事务执行。
 *
 * **tombstone 改投（P3，dedup-and-normalization「tombstone 改投」/ semantic-dedup「确定性事件合并」）**：
 * 塌缩的 `ON CONFLICT (dedup_key)` 命中行可能已被语义合并置 `merged_into` 非空（tombstone）。此时必须
 * 把该 raw_item 改塌缩进 `merged_into` 指向的**链解析后终态存活者**（`merged_into IS NULL`），禁止新建
 * 重复、禁止向 tombstone 累加 source_count。详见 collapseRawItem 内联注释（守卫谓词 + 链解析 + 并发原子性）。
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
 *    - 冲突时 set 累加 source_count、更新 last_seen_at，并对 published_at 做 COALESCE 单向
 *      NULL-fill（已设值不覆盖，design D8）。
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

  // 经上方早返回后 dedupKey 必非空；捕获到 const 使其类型在事务闭包内仍为 string（窄化不跨闭包）。
  const dedupKey: string = norm.dedupKey;
  const now = new Date();

  // 「INSERT/ON CONFLICT 塌缩（含 tombstone 改投）」+「markCollapsed 该 raw_item」必须原子提交（同一事务）：
  // 否则崩在二者之间 → 下轮 collapseUncollapsedRawItems 重扫到该 raw_item（collapsed 仍 false）
  // → source_count 再 +1，违反「每 raw_item 恰好贡献一次」。崩在中间整体回滚，下轮重做仍只累加一次。
  // dbh 可能本身已是事务句柄；drizzle 的 tx.transaction() 会以 savepoint 嵌套，安全复用。
  await dbh.transaction(async (tx) => {
    // ── INSERT ... ON CONFLICT (dedup_key) DO UPDATE，**DO UPDATE 加 `merged_into IS NULL` 守卫**。
    // 守卫语义（P3 tombstone 改投并发原子性，dedup-and-normalization「改投的并发原子性」为权威）：
    //   - 首建（无冲突）：INSERT 成功，returning 返回新行 event_id。
    //   - 命中非 tombstone 行（merged_into IS NULL）：DO UPDATE 守卫满足 → source_count+1、
    //     last_seen 更新、published_at COALESCE 单向 NULL-fill，returning 返回该行 event_id。
    //   - 命中 tombstone 行（merged_into 非空）：DO UPDATE 守卫**不满足** → 0 行更新、**不动 tombstone**
    //     （绝不把已冻结的 tombstone source_count 误 +1），returning 为空 → 下方走链解析改投存活者。
    // ON CONFLICT 对冲突行本就持行锁，故命中 tombstone 时该行已被本事务锁住，与并发语义合并
    // （对被吞行 FOR UPDATE）争同一 dedup_key 行锁而串行化（合并先/塌缩先两序皆不丢不重）。
    const upserted = await tx
      .insert(aiNewsEvents)
      .values({
        // event_id 省略 → DB 默认 gen_random_uuid()::text 生成不透明身份（design D1）。
        dedupKey,
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
        // set 累加 source_count、更新 last_seen_at；published_at 经 COALESCE 单向 NULL-fill
        // （仅 NULL→已知补值，已设值绝不被覆盖）——绝不覆盖身份/代表/first_seen_at（design D8）。
        // EXCLUDED.published_at 是 ON CONFLICT 的 proposed-insertion 行列名（snake_case）。
        set: {
          sourceCount: sql`${aiNewsEvents.sourceCount} + 1`,
          lastSeenAt: now,
          publishedAt: sql`COALESCE(${aiNewsEvents.publishedAt}, EXCLUDED.published_at)`,
        },
        // ⚠️ tombstone 改投守卫：命中行 merged_into 非空时不更新（不动 tombstone source_count）。
        setWhere: sql`${aiNewsEvents.mergedInto} IS NULL`,
      })
      .returning({ eventId: aiNewsEvents.eventId });

    // returning 为空 = 命中 tombstone（DO UPDATE 守卫未满足、INSERT 也因冲突未发生）→ 改投存活者。
    if (upserted.length === 0) {
      await rerouteToSurvivor(tx, dedupKey, now);
    }

    // 塌缩成功后把该 raw_item 置 collapsed=true：source_count 贡献恰好一次（幂等，design D1）。
    await markCollapsed(tx, item.id);
  });

  return { rawItemId: item.id, dedupKey, unprocessable: false };
}

/**
 * tombstone 改投：命中 tombstone 的 `dedup_key` 行时，把本 raw_item 的 source_count +1 改投到
 * **链解析后终态存活者**（`merged_into IS NULL`）。
 *
 * 流程（在塌缩事务内、命中行已被 ON CONFLICT 行锁锁住后调用）：
 * 1. 读命中 tombstone 行的 merged_into，沿链 `SELECT ... FOR UPDATE` 迭代到终态存活者
 *    （`merged_into IS NULL`）；带**环路保护**（已访问集合，命中环报错告警），不停在中间 tombstone。
 * 2. `UPDATE 存活者 SET source_count = source_count + 1, last_seen_at = now`——增量只落存活者，
 *    **绝不**加到 tombstone（被吞 tombstone 的 source_count 此后冻结，semantic-dedup「source_count
 *    不重复计数」）。published_at 不在此改投（tombstone 改投只贡献「新到 raw_item +1」，published_at
 *    的确定性 NULL-fill 由首建/正常 DO UPDATE 路径承载；存活者 published_at 在合并时已 COALESCE）。
 *
 * **并发原子性**：靠冲突 dedup_key 那一行的行锁与并发语义合并（合并对被吞行 FOR UPDATE）串行化——
 * 合并先提交 → 塌缩读到 merged_into 非空 → +1 落存活者；塌缩先提交（但此分支是命中已 tombstone 行、
 * 由本函数 +1 落存活者）→ 自洽。两序皆不丢不重（dedup-and-normalization「改投的并发原子性」为权威）。
 */
async function rerouteToSurvivor(
  tx: TxLike,
  dedupKey: string,
  now: Date,
): Promise<void> {
  // 沿 merged_into 链迭代到终态存活者；链上每行 FOR UPDATE（与并发合并/改投串行化）+ 环路保护。
  const visited = new Set<string>();

  // 起点：命中的 tombstone 行（按 dedup_key 定位，ON CONFLICT 已持其行锁；显式再 FOR UPDATE 取 merged_into）。
  const startRows = await tx
    .select({ eventId: aiNewsEvents.eventId, mergedInto: aiNewsEvents.mergedInto })
    .from(aiNewsEvents)
    .where(eq(aiNewsEvents.dedupKey, dedupKey))
    .for('update');
  const start = startRows[0];
  if (!start) {
    // 理论不应发生（命中冲突却查不到该 dedup_key 行）；记并返回，不新建重复、不抛断整批。
    console.error(
      `[collapse] tombstone 改投：按 dedup_key 未找到命中行（dedup_key=${dedupKey.slice(0, 16)}…），跳过改投。`,
    );
    return;
  }
  // 若命中行其实 merged_into IS NULL（极少数竞态：守卫与本读之间刚被「复活」？不应发生）——
  // 那么它本身就是存活者，直接对其 +1（与正常 DO UPDATE 等价）。
  let currentId = start.eventId;
  let mergedInto = start.mergedInto;

  while (mergedInto !== null) {
    if (visited.has(currentId)) {
      throw new Error(
        `collapse: tombstone 改投的 merged_into 链检出环路（已访问 ${currentId}），中止改投并告警——数据异常。`,
      );
    }
    visited.add(currentId);
    currentId = mergedInto;
    const rows = await tx
      .select({ eventId: aiNewsEvents.eventId, mergedInto: aiNewsEvents.mergedInto })
      .from(aiNewsEvents)
      .where(eq(aiNewsEvents.eventId, currentId))
      .for('update');
    const row = rows[0];
    if (!row) {
      throw new Error(
        `collapse: tombstone 改投的 merged_into 链断裂（${currentId} 不存在），中止改投并告警——数据异常。`,
      );
    }
    mergedInto = row.mergedInto;
  }

  // currentId 为终态存活者（merged_into IS NULL）：仅对其 source_count +1（新到 raw_item 的贡献）+ 更新 last_seen。
  await tx
    .update(aiNewsEvents)
    .set({
      sourceCount: sql`${aiNewsEvents.sourceCount} + 1`,
      lastSeenAt: now,
    })
    .where(eq(aiNewsEvents.eventId, currentId));
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
