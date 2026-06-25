-- add-model-radar-data-model（P5 / 5a）：Model Radar 隔离 mr_* bounded domain 数据模型（forward-only）。
--
-- 新建 11 张 mr_* 表承载厂商/套餐/模型兼容/工具协议兼容/带类型限额/价格历史/来源与待复核状态。
-- 全沿用既有惯例：id varchar(128) DEFAULT gen_random_uuid()::text 代理键（与 event_id/product_id/
-- ai_experiences.id 同口径，使 mr_review_flag.target_id 互引各身份表 PK 类型相容）；零外键、零 pg-enum、
-- 零 DB CHECK、零 partial index（取值集合法性落应用层 Zod，见 src/db/mr-schema.zod.ts）；唯一键一律
-- 命名表级约束（经 information_schema.table_constraints 可断言）。仅 CREATE TABLE + 唯一约束，不 ALTER 既有表、
-- 不含 CREATE EXTENSION。
--
-- 幂等口径 = 经 drizzle-kit migrate（drizzle journal 跳过已应用项），**非** SQL 文件自身可重入
-- （CREATE TABLE 非 IF NOT EXISTS，裸跑两次会报错——幂等须经 npm run migrate；与 0006/0007 注释口径一致）。
CREATE TABLE "mr_catalog_version" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"version" bigint NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_catalog_version_version_key" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "mr_models" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vendor_id" varchar(128) NOT NULL,
	"family" text NOT NULL,
	"version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_models_vendor_id_family_version_key" UNIQUE("vendor_id","family","version")
);
--> statement-breakpoint
CREATE TABLE "mr_plan_clients" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"client_type" text NOT NULL,
	"client_id" text NOT NULL,
	"source_url" text NOT NULL,
	"last_checked" timestamp with time zone NOT NULL,
	"source_confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_plan_clients_plan_id_client_type_client_id_key" UNIQUE("plan_id","client_type","client_id")
);
--> statement-breakpoint
CREATE TABLE "mr_plan_limits" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"limit_type" text NOT NULL,
	"value" numeric,
	"window" text NOT NULL,
	"source_url" text NOT NULL,
	"last_checked" timestamp with time zone NOT NULL,
	"source_confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_plan_limits_plan_id_limit_type_window_key" UNIQUE("plan_id","limit_type","window")
);
--> statement-breakpoint
CREATE TABLE "mr_plan_models" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"model_id" varchar(128) NOT NULL,
	"source_url" text NOT NULL,
	"last_checked" timestamp with time zone NOT NULL,
	"source_confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_plan_models_plan_id_model_id_key" UNIQUE("plan_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "mr_plan_sources" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"source_id" varchar(128) NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_plan_sources_source_id_plan_id_key" UNIQUE("source_id","plan_id")
);
--> statement-breakpoint
CREATE TABLE "mr_plans" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"vendor_id" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"current_price" numeric(12, 2),
	"currency" varchar(3),
	"source_url" text NOT NULL,
	"last_checked" timestamp with time zone NOT NULL,
	"source_confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_plans_vendor_id_name_key" UNIQUE("vendor_id","name")
);
--> statement-breakpoint
CREATE TABLE "mr_price_history" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"old_value" numeric(12, 2),
	"new_value" numeric(12, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"source_url" text NOT NULL,
	"source_confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_price_history_plan_id_changed_at_key" UNIQUE("plan_id","changed_at")
);
--> statement-breakpoint
CREATE TABLE "mr_review_flag" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" varchar(128) NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_review_flag_target_type_target_id_key" UNIQUE("target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "mr_source" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"source_url" text NOT NULL,
	"vendor_id" varchar(128) NOT NULL,
	"fetch_strategy" text NOT NULL,
	"content_fingerprint" text,
	"last_checked" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_source_vendor_id_source_url_key" UNIQUE("vendor_id","source_url")
);
--> statement-breakpoint
CREATE TABLE "mr_vendors" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"normalized_name" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_vendors_normalized_name_key" UNIQUE("normalized_name")
);
