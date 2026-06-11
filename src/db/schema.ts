/**
 * Drizzle schema —— 三张承重表（P0 建立，P1 演进）。
 *
 * 对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL，并叠加 P1 的硬去重 / 推送链路所需列
 * （platform-foundation MODIFIED：event_id surrogate key、dedup_key、
 * representative_raw_item_id、published_at、title_hash、unprocessable）。
 *
 * 零向量不变量（design / spec「PostgreSQL 使用 pgvector 镜像但不启用向量能力」）：
 * 本文件禁止任何 vector 列、禁止 pgvector 相关 import / CREATE EXTENSION。
 *
 * 仅三表不变量（spec「数据库 Schema 可迁移」）：
 * P1 仍禁止定义其余六张表（item_event_relations / item_product_relations /
 * ai_products / kb_ingestion_records / ai_tools / task_patterns），P1 用 1:1 模型，
 * 关系表留待 P3 语义合并时提案再加。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
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
