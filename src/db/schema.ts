/**
 * Drizzle schema —— 承重表（P0 建立，P1/P2 演进，P3 补向量与知识库）。
 *
 * 对齐 QA.md §8.1 / §8.2 / §8.6 / §8.7 的 DDL，并叠加 P1 的硬去重 / 推送链路所需列
 * （platform-foundation MODIFIED：event_id surrogate key、dedup_key、
 * representative_raw_item_id、published_at、title_hash、unprocessable）。
 *
 * 向量能力（P3 起按需启用，design「迁移计划」/ spec「P3 向量与知识库 Schema 可迁移」）：
 * 仅 `ai_news_events`（语义去重 embedding）与 `kb_documents`（知识库检索 embedding）含
 * `vector(1536)` 列；`ai_products` 等其余表仍禁止 vector 列（产品语义合并不在 P3 范围）。
 * 向量维度钉死 1536（所选默认模型 `text-embedding-3-small`）——换不同维度模型属新的
 * forward-only 迁移，不在本期热切。`CREATE EXTENSION IF NOT EXISTS vector;` 由 P3 迁移落。
 *
 * 受限表集不变量（spec「数据库 Schema 可迁移」/「ai_products 产品表可迁移」）：
 * P2 解禁并新建 `ai_products`（产品发现硬规则合并所需）；P3 解禁并新建 `kb_documents` /
 * `kb_ingestion_records`（本地表知识库 + 入库幂等日志）；add-ai-blogger-experience-mining
 * 解禁并新建 `ai_experiences`（AI 博主经验卡片所需，见 blogger-experience-mining spec）；
 * 仍禁止定义其余三张表（item_event_relations / item_product_relations / ai_tools /
 * task_patterns）——事件-产品关系表 P3 改用 `ai_news_events.merged_into` tombstone 替代、
 * 不建关系表；工具/任务模式表留待 P5 顾问期提案再加。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * pgvector `vector(N)` 列类型（drizzle 无内置，经 customType 自定义；不引入 `pgvector` npm 包）。
 *
 * - DDL：`drizzle-kit generate` 据 `dataType()` 输出 `vector(1536)`，与 pgvector 的定长向量列一致。
 * - 维度钉死 1536（design D1）：构造时传 `{ dimensions: 1536 }`，换维度=新迁移。
 * - driver 值映射：写入把 `number[]` 序列化为 `[v1,v2,...]` 文本（pgvector 接受的字面量）；读取
 *   时 driver 回传 pgvector 的文本表示（如 `[0.1,0.2,...]`），`fromDriver` 解析回 `number[]`，使
 *   `data: number[]` 的声明类型与运行期值一致（消费方拿到的恒为数组，不是 `[...]` 字符串）。
 * `CREATE EXTENSION vector` 不由列类型负责——在迁移 SQL 顶部显式 `CREATE EXTENSION IF NOT EXISTS vector;`。
 */
const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // pgvector 文本表示 `[v1,v2,...]` → number[]。去首尾括号后按逗号切分；空向量返回 []。
    const inner = value.replace(/^\[/, '').replace(/\]$/, '');
    if (inner.length === 0) return [];
    return inner.split(',').map((s) => Number(s));
  },
});

/**
 * 原始信息表（QA.md §8.1）。
 * `canonical_url` 自 P1 起在采集/规范化阶段真正生成并写入（去 utm/ref 等追踪参数）。
 * `title_hash` 承载标题归一化哈希；`unprocessable` 标记「既无 canonical_url 又归一后标题为空」
 * 的兜底状态（不入 event）。
 * `normalizer_version` 等归一规则版本号写入 `metadata`（design D4），便于 P3 回填识别版本差异。
 */
export const rawItems = pgTable(
  'raw_items',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    source: varchar('source', { length: 64 }).notNull(),
    sourceItemId: varchar('source_item_id', { length: 255 }),
    rawType: varchar('raw_type', { length: 64 }),
    url: text('url'),
    canonicalUrl: text('canonical_url'),
    title: text('title').notNull(),
    titleHash: varchar('title_hash', { length: 64 }),
    content: text('content'),
    author: varchar('author', { length: 255 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // 兜底状态：无 canonical_url 且归一后标题为空串 → true，不产生 event（design D3）。
    unprocessable: boolean('unprocessable').notNull().default(false),
    // 持久化「已塌缩」标记：塌缩成功（或判定 unprocessable）后置 true，使塌缩对 raw_item 幂等。
    // 塌缩入口只扫 unprocessable=false AND collapsed=false 的行——不依赖本轮 insertedIds，
    // 既避免「全重复日 insertedIds=0 误判全 unprocessable 告警」，也保证「INSERT 后崩溃、
    // 下次因 source_item_id 重复被 DO NOTHING 跳过的 raw_item 仍会被补塌缩」（Codex C1）。
    collapsed: boolean('collapsed').notNull().default(false),
    metadata: jsonb('metadata'),
  },
  (table) => [
    unique('raw_items_source_source_item_id_key').on(
      table.source,
      table.sourceItemId,
    ),
  ],
);

/**
 * 新闻事件表（QA.md §8.2，P1 演进）。
 * 评分列（*_score）与 should_push 是 Value Judge 落库目标。
 *
 * event_id 不变量（design D1 / spec）：不透明 surrogate key，列类型保持
 * VARCHAR(128)（与 push_records.target_id 一致，使 target_id=event_id 互引类型相容；
 * 不可改成 PG uuid 类型否则两列不兼容），数据库默认 `gen_random_uuid()::text`。
 * 塌缩 INSERT 必须**省略** event_id 由 DB 生成，禁止应用层用内容派生值填充。
 *
 * 塌缩不变量（design D1/D2，本组只建 schema、塌缩由后续组实现）：
 * `INSERT ... ON CONFLICT (dedup_key) DO UPDATE` 时，UPDATE 分支只累加 source_count、
 * 更新 last_seen_at，**禁止覆盖** event_id / representative_raw_item_id /
 * representative_title / first_seen_at / published_at。
 */
export const aiNewsEvents = pgTable('ai_news_events', {
  // 不透明 surrogate key：DB 默认 gen_random_uuid()::text 生成，禁止内容派生（design D1）。
  eventId: varchar('event_id', { length: 128 })
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  eventType: varchar('event_type', { length: 64 }),
  // 硬去重塌缩的冲突键：sha256(canonical_url) 或 sha256(title_hash)（design D3）。
  dedupKey: text('dedup_key'),
  // 塌缩首建时记录第一条命中的 raw_item 主键（廉价回指，供调试/摘要引用原文，design D2）。
  representativeRawItemId: bigint('representative_raw_item_id', {
    mode: 'bigint',
  }),
  representativeTitle: text('representative_title'),
  summaryZh: text('summary_zh'),
  // 一句话要点（可空，forward-only：迁移 0003 ALTER ADD COLUMN）。
  // 中文摘要 Agent 与 summary_zh 同一次产出、校验后落库，供 Telegram 日报渲染。
  // 旧行（迁移前已落库）保持 NULL，由日报渲染层按固定顺序回退。
  headlineZh: text('headline_zh'),
  mainEntities: jsonb('main_entities'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  // 代表 raw_item 的发布时间，供 Top N 排序 tiebreaker（published_at DESC NULLS LAST）。
  publishedAt: timestamp('published_at', { withTimezone: true }),
  sourceCount: integer('source_count').default(1),
  importanceScore: numeric('importance_score', { precision: 5, scale: 2 }),
  noveltyScore: numeric('novelty_score', { precision: 5, scale: 2 }),
  developerRelevanceScore: numeric('developer_relevance_score', {
    precision: 5,
    scale: 2,
  }),
  hypeRiskScore: numeric('hype_risk_score', { precision: 5, scale: 2 }),
  shouldPush: boolean('should_push').default(false),
  // 并发评分原子 claim（design D6 / spec「judge_claimed_at」）：日报链与实时告警高频链
  // 可能并发对同一未评分事件评分。送 LLM 前 `UPDATE ... SET judge_claimed_at WHERE
  // *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now()-interval 'T')
  // RETURNING` 原子 claim，仅 claim 成功者评分——防双评分覆写。超时回收阈值 T>L+W 使
  // claim 后崩溃的事件可被后续运行重新 claim（僵尸 claim 回收）。本组只建列，claim 逻辑后续组。
  judgeClaimedAt: timestamp('judge_claimed_at', { withTimezone: true }),
  // P3 语义去重 embedding（可空，design D1/D2）：value-judge/digest 之前由语义层生成并落库，
  // 维度钉死 1536（text-embedding-3-small）。NULL = 尚未嵌入或空文本兜底跳过（保留独立、不合并）。
  embedding: vector('embedding', { dimensions: 1536 }),
  // P3 语义合并 tombstone 指针（可空，design D5/D5a）：被吞事件置 merged_into=存活 event_id，
  // 不物理删除——保留 dedup_key 唯一占位、可观测可回溯。所有「把行当独立事件用」的下游读点
  // 必须排除 merged_into IS NOT NULL（spec「tombstone 对所有下游消费者不可见」），否则被吞事件复活重推。
  mergedInto: varchar('merged_into', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  // 硬去重塌缩的 ON CONFLICT 冲突目标（design D1/D3）。
  unique('ai_news_events_dedup_key_key').on(table.dedupKey),
]);

/**
 * 推送记录表（QA.md §8.6）。
 * UNIQUE(target_type, target_id, channel, push_date) 是推送幂等地基，
 * 第 0 天即就位（spec「推送幂等唯一约束就位」/ design D3）。本期不实跑写入。
 */
export const pushRecords = pgTable(
  'push_records',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: varchar('target_id', { length: 128 }).notNull(),
    channel: varchar('channel', { length: 32 }).notNull(),
    pushDate: date('push_date').notNull(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    status: varchar('status', { length: 32 }).notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique('push_records_target_type_target_id_channel_push_date_key').on(
      table.targetType,
      table.targetId,
      table.channel,
      table.pushDate,
    ),
  ],
);

/**
 * 产品表（QA.md §8.3，P2 新增）。
 * 承载产品发现的硬规则合并：Product Hunt 等源先落 `raw_items(raw_type='product')`，
 * 再由确定性产品塌缩步骤读 raw_items 写本表（镜像 raw_items → ai_news_events 塌缩模式）。
 *
 * product_id 不变量（design D4 / spec「ai_products 产品表可迁移」）：与 event_id 同口径——
 * 不透明 surrogate key，VARCHAR(128)（与 push_records.target_id 一致，使 target_id=product_id
 * 互引类型相容），数据库默认 `gen_random_uuid()::text`，禁止内容派生。
 *
 * 硬合并唯一约束：UNIQUE(canonical_domain) / UNIQUE(github_repo) / UNIQUE(product_hunt_slug)
 * 三者各自独立，作为塌缩 `ON CONFLICT` 冲突目标；NULL 键不参与约束（PG UNIQUE 放行多 NULL 行）。
 * 合并由 DB 唯一约束 + 确定性程序保障，绝不交 LLM。
 *
 * ai_products 无向量不变量：P3 已启用 pgvector，但向量能力仅及 ai_news_events / kb_documents——
 * 本表仍禁止任何 vector 列（产品语义合并不在 P3 范围，仍用硬规则合并，spec「ai_products 不含向量列」）。
 *
 * 本期富化列（QA §8.3 的 vendor/category/score 等）留 P5 顾问期 forward-only 追加，
 * 本期仅建硬合并/推送所需列。representative_raw_item_id 为 P2 新增过渡列（QA §8.3 DDL 未列，
 * 有意偏离），在不建 item_product_relations（P3）前提下保留 raw_item↔product 回指。
 */
export const aiProducts = pgTable(
  'ai_products',
  {
    // 不透明 surrogate key：DB 默认 gen_random_uuid()::text 生成，禁止内容派生（design D4）。
    productId: varchar('product_id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // QA §8.3 唯一 NOT NULL 业务列：塌缩 INSERT 必填（取 raw_item.title，缺失兜底 slug/domain）。
    name: varchar('name', { length: 255 }).notNull(),
    // 产品中文展示列（可空）：中文化 Agent 写入，NULL = 未中文化 → 渲染回退英文 name。
    // 仅产展示文本，绝不参与塌缩/合并/推送幂等等确定性状态判定。
    nameZh: varchar('name_zh', { length: 255 }),
    taglineZh: text('tagline_zh'),
    // 硬规则合并冲突键（各自 UNIQUE，作 ON CONFLICT 目标）；NULL 不参与约束。
    canonicalDomain: varchar('canonical_domain', { length: 255 }),
    githubRepo: varchar('github_repo', { length: 255 }),
    productHuntSlug: varchar('product_hunt_slug', { length: 255 }),
    // last_seen 类可累加列：硬合并 UPDATE 分支累加/更新（本期必建，UPDATE 累加目标）。
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    // 多键命中多行冲突态以 metadata.merge_conflict 标记落点（本期必建，推送排除规则依赖）。
    metadata: jsonb('metadata'),
    // P2 过渡列：回指 raw_items.id（类型与 ai_news_events.representative_raw_item_id 一致）。
    representativeRawItemId: bigint('representative_raw_item_id', {
      mode: 'bigint',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique('ai_products_canonical_domain_key').on(table.canonicalDomain),
    unique('ai_products_github_repo_key').on(table.githubRepo),
    unique('ai_products_product_hunt_slug_key').on(table.productHuntSlug),
  ],
);

/**
 * 本地表知识库（P3 新增，design D7 / spec「本地表知识库存储」）。
 * 仅精选内容入库（准入闸 `long_term_value >= 70`，知识库不是垃圾桶）；候选 = 当日推送 success
 * 且非 tombstone（`merged_into IS NULL`）的事件。入库由程序执行（LLM 仅产入库元数据）。
 *
 * 本表自身**无业务唯一约束**——幂等由 `kb_ingestion_records` 的 UNIQUE(target_type,target_id,kb_provider)
 * 保障（两表同事务写入、状态感知认领，见 spec「知识库入库幂等」）。`id` 由 kb_ingestion_records.kb_document_id 回指。
 * `embedding vector(1536)` 供未来检索（本期不建 HNSW 索引，数据量上来再单独优化，design D4 同理）。
 */
export const kbDocuments = pgTable('kb_documents', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  // 目标实体类型/标识（与 push_records / kb_ingestion_records 同口径）：本期仅事件入库（target_type='event'）。
  targetType: varchar('target_type', { length: 32 }).notNull(),
  targetId: varchar('target_id', { length: 128 }).notNull(),
  kbTitle: text('kb_title'),
  summaryZh: text('summary_zh'),
  // 标签/实体/来源 URL：知识摘要 Agent 产出的结构化数组，jsonb 存储。
  tags: jsonb('tags'),
  entities: jsonb('entities'),
  sourceUrls: jsonb('source_urls'),
  eventDate: date('event_date'),
  // 长期价值分（准入闸已在程序层过滤 >= 70；列保留全量值供审计）。
  longTermValue: integer('long_term_value'),
  // 知识库检索 embedding（可空，供未来检索）；维度钉死 1536，同 ai_news_events.embedding。
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * 知识库入库记录表（QA.md §8.7，P3 新增 / spec「知识库入库幂等」）。
 * `UNIQUE(target_type, target_id, kb_provider)` 保障同一目标对同一 provider **最终只成功一次**。
 *
 * 状态感知认领（design D7 / spec）：`INSERT(pending) ON CONFLICT DO UPDATE SET status='pending'
 * WHERE status<>'success' RETURNING`——success 跳过、failed/僵尸 pending 重新抢到重试；**绝不用
 * DO NOTHING**（否则 failed 永久挡死重试）。认领成功后「插 kb_documents + 置 success + 回指
 * kb_document_id」同一事务（本组只建 schema，认领/事务逻辑由组 E 实现）。
 * `kb_provider='custom'` 指向本地表 kb_documents；`kb_document_id` 回指 kb_documents.id（文本，QA §8.7）。
 */
export const kbIngestionRecords = pgTable(
  'kb_ingestion_records',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: varchar('target_id', { length: 128 }).notNull(),
    // dify/ragflow/custom（QA §8.7）：本期仅 'custom' 接线，其余取值预留不接。
    kbProvider: varchar('kb_provider', { length: 64 }).notNull(),
    // 回指 kb_documents.id（QA §8.7 为 VARCHAR(255)，沿用原 DDL 类型，不改既有列语义）。
    kbDocumentId: varchar('kb_document_id', { length: 255 }),
    status: varchar('status', { length: 32 }).notNull(),
    ingestedAt: timestamp('ingested_at'),
    errorMessage: text('error_message'),
  },
  (table) => [
    unique('kb_ingestion_records_target_type_target_id_kb_provider_key').on(
      table.targetType,
      table.targetId,
      table.kbProvider,
    ),
  ],
);

/**
 * AI 博主经验卡片表（add-ai-blogger-experience-mining，design D7 / spec
 * blogger-experience-mining「经验卡片实体表与确定性去重幂等」）。
 *
 * 与新闻/产品/论文链并行的「实践经验」进料：经验提炼 Agent 对 `source='blogger'` +
 * `raw_type='experience'` 的 raw_items 产出结构化卡片落本表；高价值（>=70）入 KB，
 * 每日「实践锦囊」段内联日报推送。
 *
 * id 不变量（design D7 / spec）：与 event_id/product_id 同口径——不透明 surrogate key，
 * VARCHAR(128)（与 push_records.target_id 一致，使 `target_id=id` 互引类型相容；同一卡片
 * 在 push 幂等命名空间与 KB 幂等命名空间用同一 target_id），DB 默认 `gen_random_uuid()::text`。
 *
 * 去重不变量（design D4 / spec）：唯一键 = `canonical_source_url`（经验行规范化来源 URL，
 * NOT NULL）+ `UNIQUE(canonical_source_url)`，由经验链 `ON CONFLICT (canonical_source_url)`
 * 收敛——**纯程序键 + DB 唯一约束，绝不由 LLM 判定是否重复**。同一来源（同视频/博文、同
 * watch URL）即便经不同 feed 采到不同 raw_item（`source_item_id` 不同），也因
 * `canonical_source_url` 相同而收敛为一行。不用 `raw_item_id` 作唯一键（拦不住跨 feed）。
 *
 * `representative_raw_item_id` 存为 provenance（裸 bigint，**对齐既有零 FK 惯例**——
 * 既有 ai_news_events/ai_products 的 representative_raw_item_id 是裸 bigint 无外键；本表
 * 取 NOT NULL，因每张卡片必有 provenance raw_item）。
 *
 * `long_term_value`（0..100）由提炼 Agent 产出并 Zod `int().min(0).max(100)` 约束，兼作 KB
 * 准入闸（>=KB_ADMISSION_FLOOR）与实践锦囊推送排序键——不另设 importance_score。**不加 DB
 * CHECK(0..100)**：有意对齐基线零-CHECK 惯例（全库 *_score 均无 CHECK），0..100 边界唯一防线
 * 是提炼 Agent 的 Zod 校验（合规于「Agent 输出必 Zod 校验」不变量）。
 *
 * `published_at`（可空）取自 raw_items，供实践锦囊推送 recency 窗口；NULL 卡片仅入 KB 不进推送
 * （recency 窗口对 NULL 求假，design D6）。
 *
 * **无向量列、无二级索引**（对齐基线惯例——全库零 secondary index，数据量小排序顺序扫足够，
 * 未来慢了再单独 forward-only 迁移加索引；UNIQUE(canonical_source_url) 自带索引已够去重 ON CONFLICT）。
 */
export const aiExperiences = pgTable(
  'ai_experiences',
  {
    // 不透明 surrogate key：DB 默认 gen_random_uuid()::text 生成（与 event_id/product_id 同口径）。
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // 去重唯一键：经验行 raw_items.canonical_url，ON CONFLICT 冲突目标。
    canonicalSourceUrl: text('canonical_source_url').notNull(),
    // provenance 回指 raw_items.id（裸 bigint 无外键，对齐基线零 FK 惯例；每卡片必有故 NOT NULL）。
    representativeRawItemId: bigint('representative_raw_item_id', {
      mode: 'bigint',
    }).notNull(),
    // 结构化经验字段（提炼 Agent 产出）。
    scenario: text('scenario'),
    tools: jsonb('tools'),
    techniques: text('techniques'),
    applicability: text('applicability'),
    // 长期价值分（0..100，Zod 约束；KB 准入闸 + 实践锦囊排序键，不另设 importance_score）。
    longTermValue: integer('long_term_value').notNull(),
    // 推送展示文本。
    headlineZh: text('headline_zh'),
    summaryZh: text('summary_zh'),
    // 发布时间（取自 raw_items，供推送 recency 窗口；NULL → 仅入 KB 不进推送）。
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique('ai_experiences_canonical_source_url_key').on(
      table.canonicalSourceUrl,
    ),
  ],
);

/* ────────────────────────────────────────────────────────────────────────
 * Model Radar（P5 / 5a，add-model-radar-data-model）—— 隔离的 `mr_*` bounded domain。
 *
 * 承载厂商/套餐/模型兼容/工具协议兼容/带类型限额/价格历史/来源与待复核状态。每张**断言事实**表
 * （`mr_plans`/`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`）各带 provenance 三字段；
 * `mr_price_history` 为例外（append-only 历史行，`changed_at` 兼任核对时间，不单建 last_checked）。
 *
 * 全沿用既有惯例（design D7/D8/D10/D11/D12，经 grep 核实）：
 * - PK = `id varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text`（对齐
 *   ai_products/ai_news_events/ai_experiences 代理键；使 mr_review_flag.target_id 可统一引各身份表 PK）。
 * - 零 FK（引用列裸 varchar(128)，不 references）、零 pg-enum、零 DB CHECK、零 partial index。
 *   取值集合法性一律落应用层 Zod（见 ./mr-schema.zod.ts），DB 不约束（与 ai_experiences 注释同口径）。
 * - 唯一键一律命名表级 `unique('<name>').on(...)`（非列级 .unique() 链）；每个唯一键组件列 `.notNull()`
 *   （PG UNIQUE 对 NULL distinct，组件可空会让去重键静默失效）。
 * - 引用完整性 / current=latest 双写 / family 小写归一 / append-only / none-行互斥 = 5b 录入契约，非 5a DB 强制。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 厂商身份表（design D3/D4 豁免）。身份行（实体存在性），不挂 provenance——其时效由所属 plan
 * 兼容行 provenance 间接承载。`normalized_name` 去重键（小写归一录入是 5b 契约）。
 */
export const mrVendors = pgTable(
  'mr_vendors',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // 归一去重键（5b 录入归一小写）；UNIQUE 组件 → NOT NULL。
    normalizedName: text('normalized_name').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('mr_vendors_normalized_name_key').on(table.normalizedName)],
);

/**
 * 模型身份表（design D3）。唯一键 = 真实三列 `UNIQUE(vendor_id, family, version)`。
 * `family` = 去版本号系列名小写（GLM-5.2→`glm`，Kimi-K2.7→`kimi`）；小写归一是 5b 录入契约，
 * 5a 不加 Zod transform/CHECK、不强制、不测。`version` NOT NULL，未标版本填哨兵 `''`（不用 NULL，
 * 否则 PG UNIQUE 放行多 NULL 让 GLM-5.2/GLM-4.7 误合）。身份行不挂 provenance（同 mr_vendors）。
 */
export const mrModels = pgTable(
  'mr_models',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    vendorId: varchar('vendor_id', { length: 128 }).notNull(),
    family: text('family').notNull(),
    version: text('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_models_vendor_id_family_version_key').on(
      table.vendorId,
      table.family,
      table.version,
    ),
  ],
);

/**
 * 套餐表（断言事实表，带 provenance 三字段，design D4/D5/D6/D11）。
 * `current_price numeric(12,2)` 与 `currency varchar(3)` 均 nullable 且**同生同灭**——
 * 登录墙后拿不到价（needs_login_recheck）时两者均 NULL 占位、不写 mr_price_history。
 * 同生同灭由应用层 Zod `.refine()` 兜（DB 零-CHECK 不挡，见 ./mr-schema.zod.ts）。
 * `updated_at` NOT NULL DEFAULT now()（design D11：刻意比既有 updated_at 更严，有 default 故 insert 永不失败）。
 */
export const mrPlans = pgTable(
  'mr_plans',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    vendorId: varchar('vendor_id', { length: 128 }).notNull(),
    // UNIQUE(vendor_id, name) 组件 → NOT NULL（真实列，非派生）。
    // 录入约定：name = 套餐全名（含产品上下文，如 'Coding Plan Pro'/'Qoder Pro'，非裸档位 'Pro'）；
    // 故 key 不含 category 仍正确（同厂跨桶全名天然不同 + 挡同名误录）。裸档位跨桶误撞属 5b 录入契约须避免。
    name: text('name').notNull(),
    category: text('category').notNull(),
    // 与 currency 同生同灭（Zod refine 兜）；needs_login_recheck 时两者皆 NULL 占位。
    currentPrice: numeric('current_price', { precision: 12, scale: 2 }),
    currency: varchar('currency', { length: 3 }),
    // provenance 三字段（断言事实表必带，design D4）。
    sourceUrl: text('source_url').notNull(),
    lastChecked: timestamp('last_checked', { withTimezone: true }).notNull(),
    sourceConfidence: text('source_confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('mr_plans_vendor_id_name_key').on(table.vendorId, table.name)],
);

/**
 * 套餐↔模型兼容 junction（断言事实表，带 provenance 三字段，design D2/D4）。
 * 兼容置信度独立于 plan 级（兼容常来自人脑/社区，不继承 plan 定价置信度）。
 * 反向索引（model_id）暂缓：快照承读 + 低百行，慢了再单独 forward-only 加（design D2）。
 */
export const mrPlanModels = pgTable(
  'mr_plan_models',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    planId: varchar('plan_id', { length: 128 }).notNull(),
    modelId: varchar('model_id', { length: 128 }).notNull(),
    sourceUrl: text('source_url').notNull(),
    lastChecked: timestamp('last_checked', { withTimezone: true }).notNull(),
    sourceConfidence: text('source_confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_plan_models_plan_id_model_id_key').on(table.planId, table.modelId),
  ],
);

/**
 * 套餐↔工具/协议兼容 junction（断言事实表，带 provenance 三字段，design D2/D4）。
 * `client_type ∈ {tool, protocol}`，UNIQUE(plan_id, client_type, client_id) 防工具/协议同名误撞。
 * 反向索引（client_id）暂缓（同 mr_plan_models 理由）。
 */
export const mrPlanClients = pgTable(
  'mr_plan_clients',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    planId: varchar('plan_id', { length: 128 }).notNull(),
    clientType: text('client_type').notNull(),
    clientId: text('client_id').notNull(),
    sourceUrl: text('source_url').notNull(),
    lastChecked: timestamp('last_checked', { withTimezone: true }).notNull(),
    sourceConfidence: text('source_confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_plan_clients_plan_id_client_type_client_id_key').on(
      table.planId,
      table.clientType,
      table.clientId,
    ),
  ],
);

/**
 * 带类型限额表（断言事实表，带 provenance 三字段，design D1/D4/D11）。
 * `value` = 无精度 `numeric`（容月级 token 900 亿 + 小数 credit；**禁 integer** 防 int32 溢出），
 * nullable（不限/登录墙占位时 NULL）。`window` = text NOT NULL 用哨兵（`'5h'`/`'week'`/`'month'`/`'none'`），
 * 不用 NULL——PG UNIQUE 对 NULL distinct，window 可空则 (plan_id, limit_type, NULL) 重复不被拒。
 * 「不限」= 恰一行 {limit_type:'none', value:NULL, window:'none'}；none 行与具名限额互斥 = 5b 契约（DB 拦不住跨行）。
 */
export const mrPlanLimits = pgTable(
  'mr_plan_limits',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    planId: varchar('plan_id', { length: 128 }).notNull(),
    limitType: text('limit_type').notNull(),
    // 无精度 numeric（禁 integer，design D1）；不限/占位时 NULL。
    value: numeric('value'),
    // 哨兵 NOT NULL（design D1，使 UNIQUE 正常去重）。
    window: text('window').notNull(),
    sourceUrl: text('source_url').notNull(),
    lastChecked: timestamp('last_checked', { withTimezone: true }).notNull(),
    sourceConfidence: text('source_confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_plan_limits_plan_id_limit_type_window_key').on(
      table.planId,
      table.limitType,
      table.window,
    ),
  ],
);

/**
 * 价格历史表（append-only，provenance 例外，design D5）。
 * provenance 仅 `source_url`/`source_confidence`/`changed_at`——`changed_at` 兼任该行记录/核对时间
 * （历史行不被重新核对，不单建 last_checked）；「再核对的新鲜度」体现在 mr_plans.current_price 的 last_checked。
 * `new_value numeric(12,2) NOT NULL`（改价必留确值 ⇒ 必有币种 → currency NOT NULL）；`old_value` nullable。
 * UNIQUE(plan_id, changed_at) 只防同刻重复 INSERT，防不住 UPDATE/DELETE 覆盖（5a 零-trigger）；
 * append-only = 5b only-INSERT 写契约，非 5a DB 强制。
 */
export const mrPriceHistory = pgTable(
  'mr_price_history',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    planId: varchar('plan_id', { length: 128 }).notNull(),
    oldValue: numeric('old_value', { precision: 12, scale: 2 }),
    newValue: numeric('new_value', { precision: 12, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    // 去重键兼记录时间（design D5）；UNIQUE 组件 → NOT NULL。
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    sourceUrl: text('source_url').notNull(),
    sourceConfidence: text('source_confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_price_history_plan_id_changed_at_key').on(
      table.planId,
      table.changedAt,
    ),
  ],
);

/**
 * 来源定位边（design D9）。`mr_source` 是被监控目标，使 5b「源指纹变 → 哪些 plan 待复核」可落地。
 * `last_checked` nullable 无 default（未抓过 ≠ 入库时刻）；`content_fingerprint` nullable（sha256 hex）。
 * 身份/定位边，不挂 provenance（design D4 豁免）。`plan.source_url` 与本表 source_url 对齐 = 5b 录入规范。
 */
export const mrSource = pgTable(
  'mr_source',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    sourceUrl: text('source_url').notNull(),
    vendorId: varchar('vendor_id', { length: 128 }).notNull(),
    fetchStrategy: text('fetch_strategy').notNull(),
    // sha256 hex（可空：未抓过无指纹）。
    contentFingerprint: text('content_fingerprint'),
    // 核对时间（可空无 default：未抓过 ≠ 入库时刻，design D11）。
    lastChecked: timestamp('last_checked', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_source_vendor_id_source_url_key').on(
      table.vendorId,
      table.sourceUrl,
    ),
  ],
);

/**
 * 源↔套餐定位边 junction（design D9）。定位边本身，不挂 provenance（design D4 豁免）。
 */
export const mrPlanSources = pgTable(
  'mr_plan_sources',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    sourceId: varchar('source_id', { length: 128 }).notNull(),
    planId: varchar('plan_id', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_plan_sources_source_id_plan_id_key').on(
      table.sourceId,
      table.planId,
    ),
  ],
);

/**
 * 待复核标（单 target 单行可变标，design D10）。普通 `UNIQUE(target_type, target_id)`（非 partial index）。
 * `target_type ∈ {plan, source, vendor}`（粗于 provenance——某兼容断言陈旧经其所属 plan 的 flag 复核）；
 * `target_id varchar(128)` 多态引三身份表 PK，故须同型 varchar(128)（design D11）。
 *
 * 写契约（必单语句 CAS，非 INSERT-then-UPDATE，落 5b）：开标/重开 = 无条件
 * `INSERT … ON CONFLICT(target_type,target_id) DO UPDATE SET status='pending', reason=excluded.reason,
 *  opened_at=now(), resolved_at=NULL`（孪生 kb_ingestion_records 同机制，reason=excluded.reason 是对其的正确扩展）；
 * 解决 = plain `UPDATE … SET status='resolved', resolved_at=now()`。
 * ponytail ceiling：单行可变标丢失「同 target 多次标记历史」——5a 不需要；要审计再建独立 append-only flag-event 日志（YAGNI）。
 */
export const mrReviewFlag = pgTable(
  'mr_review_flag',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    targetType: text('target_type').notNull(),
    targetId: varchar('target_id', { length: 128 }).notNull(),
    reason: text('reason'),
    status: text('status').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mr_review_flag_target_type_target_id_key').on(
      table.targetType,
      table.targetId,
    ),
  ],
);

/**
 * 目录版本表（design D11）。5c bump/latest 需有序唯一版本。`version bigint NOT NULL UNIQUE`
 * 无 default（由 5c bump 路径产生，5a 仅建表不写）；`built_at` NOT NULL DEFAULT now()。
 */
export const mrCatalogVersion = pgTable(
  'mr_catalog_version',
  {
    id: varchar('id', { length: 128 })
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    version: bigint('version', { mode: 'bigint' }).notNull(),
    builtAt: timestamp('built_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('mr_catalog_version_version_key').on(table.version)],
);
