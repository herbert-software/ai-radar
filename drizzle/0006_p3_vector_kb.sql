-- P3 add-semantic-dedup-and-store-hardening：向量与知识库 schema 地基（forward-only）。
--
-- 解除零向量不变量：本期起按需启用 pgvector，仅作用于 ai_news_events / kb_documents
-- （ai_products 不含 vector 列，产品语义合并不在本期范围，见 platform-foundation spec）。
--
-- CREATE EXTENSION 必须先于任何 vector(1536) 列使用（kb_documents 建表 + ai_news_events ALTER）。
-- drizzle-kit generate 不会为 customType vector 自动输出 CREATE EXTENSION，故此处手动置顶（design「迁移计划」）。
-- IF NOT EXISTS 使扩展启用自幂等；列级 ADD COLUMN / CREATE TABLE 的迁移级幂等由 drizzle journal 跳过保障
-- （非 ADD COLUMN IF NOT EXISTS，绕过 journal 裸跑两次会报错——幂等须经 drizzle-kit migrate）。
-- pg16（docker-compose / CI 用 pgvector/pgvector:pg16）镜像已含 vector 扩展，CREATE EXTENSION 即可启用。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(128) NOT NULL,
	"kb_title" text,
	"summary_zh" text,
	"tags" jsonb,
	"entities" jsonb,
	"source_urls" jsonb,
	"event_date" date,
	"long_term_value" integer,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "kb_ingestion_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(128) NOT NULL,
	"kb_provider" varchar(64) NOT NULL,
	"kb_document_id" varchar(255),
	"status" varchar(32) NOT NULL,
	"ingested_at" timestamp,
	"error_message" text,
	CONSTRAINT "kb_ingestion_records_target_type_target_id_kb_provider_key" UNIQUE("target_type","target_id","kb_provider")
);
--> statement-breakpoint
ALTER TABLE "ai_news_events" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "ai_news_events" ADD COLUMN "merged_into" varchar(128);
