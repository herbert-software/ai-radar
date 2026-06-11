-- P1 platform-foundation MODIFIED：event_id 改不透明 surrogate key + dedup_key/UNIQUE
-- + representative_raw_item_id + published_at；raw_items 新增 title_hash + unprocessable。
--
-- 采取 DROP + 按新定义 CREATE（而非顺序 ALTER）：P0 库内仅 seed 数据、push_records
-- 实际为空，DROP 无生产数据损失；顺序 ALTER 会遗留不符 surrogate 约定的脏 `seed-<id>`
-- event_id 行（design「迁移计划」/ tasks 2.4）。不重写既有 0000 基线——0000 保持原样，
-- 幂等由 journal 追加本条 0001 entry 保证（drizzle-kit migrate 已应用则跳过），
-- 本文件 SQL 自身无需可重入。
--
-- PostgreSQL ≥ 13 内置 gen_random_uuid()（本仓库 docker-compose 用 pg16），无需 pgcrypto。
DROP TABLE IF EXISTS "push_records";--> statement-breakpoint
DROP TABLE IF EXISTS "ai_news_events";--> statement-breakpoint
DROP TABLE IF EXISTS "raw_items";--> statement-breakpoint
CREATE TABLE "ai_news_events" (
	"event_id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"event_type" varchar(64),
	"dedup_key" text,
	"representative_raw_item_id" bigint,
	"representative_title" text,
	"summary_zh" text,
	"main_entities" jsonb,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"source_count" integer DEFAULT 1,
	"importance_score" numeric(5, 2),
	"novelty_score" numeric(5, 2),
	"developer_relevance_score" numeric(5, 2),
	"hype_risk_score" numeric(5, 2),
	"should_push" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ai_news_events_dedup_key_key" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "push_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(128) NOT NULL,
	"channel" varchar(32) NOT NULL,
	"push_date" date NOT NULL,
	"pushed_at" timestamp with time zone,
	"status" varchar(32) NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "push_records_target_type_target_id_channel_push_date_key" UNIQUE("target_type","target_id","channel","push_date")
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" varchar(64) NOT NULL,
	"source_item_id" varchar(255),
	"raw_type" varchar(64),
	"url" text,
	"canonical_url" text,
	"title" text NOT NULL,
	"title_hash" varchar(64),
	"content" text,
	"author" varchar(255),
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unprocessable" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "raw_items_source_source_item_id_key" UNIQUE("source","source_item_id")
);
