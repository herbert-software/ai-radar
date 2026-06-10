/**
 * Drizzle schema —— 本期（P0 Walking Skeleton）仅定义三张承重表。
 *
 * 对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL，逐列实现、不增不减不改名。
 *
 * 零向量不变量（design D2 / spec「PostgreSQL 使用 pgvector 镜像但不启用向量能力」）：
 * 本文件禁止任何 vector 列、禁止 pgvector 相关 import / CREATE EXTENSION。
 *
 * 仅三表不变量（design D3 / spec「数据库 Schema 可迁移」）：
 * 禁止定义其余六张表（item_event_relations / item_product_relations /
 * ai_products / kb_ingestion_records / ai_tools / task_patterns），留待各自期次。
 */
import {
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
 * `canonical_url` 本期建好但不生成其值，P1 去重直接复用。
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
    content: text('content'),
    author: varchar('author', { length: 255 }),
    publishedAt: timestamp('published_at'),
    fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
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
 * 新闻事件表（QA.md §8.2）。
 * 评分列（*_score）与 should_push 是 Value Judge 落库目标（design D4）。
 */
export const aiNewsEvents = pgTable('ai_news_events', {
  eventId: varchar('event_id', { length: 128 }).primaryKey(),
  eventType: varchar('event_type', { length: 64 }),
  representativeTitle: text('representative_title'),
  summaryZh: text('summary_zh'),
  mainEntities: jsonb('main_entities'),
  firstSeenAt: timestamp('first_seen_at'),
  lastSeenAt: timestamp('last_seen_at'),
  sourceCount: integer('source_count').default(1),
  importanceScore: numeric('importance_score', { precision: 5, scale: 2 }),
  noveltyScore: numeric('novelty_score', { precision: 5, scale: 2 }),
  developerRelevanceScore: numeric('developer_relevance_score', {
    precision: 5,
    scale: 2,
  }),
  hypeRiskScore: numeric('hype_risk_score', { precision: 5, scale: 2 }),
  shouldPush: boolean('should_push').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

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
    pushedAt: timestamp('pushed_at'),
    status: varchar('status', { length: 32 }).notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
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
