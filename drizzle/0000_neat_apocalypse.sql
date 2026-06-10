CREATE TABLE "ai_news_events" (
	"event_id" varchar(128) PRIMARY KEY NOT NULL,
	"event_type" varchar(64),
	"representative_title" text,
	"summary_zh" text,
	"main_entities" jsonb,
	"first_seen_at" timestamp,
	"last_seen_at" timestamp,
	"source_count" integer DEFAULT 1,
	"importance_score" numeric(5, 2),
	"novelty_score" numeric(5, 2),
	"developer_relevance_score" numeric(5, 2),
	"hype_risk_score" numeric(5, 2),
	"should_push" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "push_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(128) NOT NULL,
	"channel" varchar(32) NOT NULL,
	"push_date" date NOT NULL,
	"pushed_at" timestamp,
	"status" varchar(32) NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
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
	"content" text,
	"author" varchar(255),
	"published_at" timestamp,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "raw_items_source_source_item_id_key" UNIQUE("source","source_item_id")
);
