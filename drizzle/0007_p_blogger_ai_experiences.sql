-- add-ai-blogger-experience-mining：AI 博主经验卡片表（forward-only）。
--
-- 新建 ai_experiences 承载经验提炼 Agent 产出的结构化卡片（与新闻/产品/论文链并行的「实践经验」进料）。
-- id varchar(128) DEFAULT gen_random_uuid()::text 与 event_id/product_id 同口径，使
-- push_records.target_id = ai_experiences.id 互引类型相容。去重唯一键 = canonical_source_url
-- （NOT NULL UNIQUE），由经验链 ON CONFLICT (canonical_source_url) 收敛——纯程序键 + DB 约束、不调 LLM。
-- representative_raw_item_id 裸 bigint 无外键（对齐既有零 FK 惯例）。无向量列、无二级索引（对齐基线惯例）。
--
-- 幂等口径 = 经 drizzle-kit migrate（drizzle journal 跳过已应用项），**非** SQL 文件自身可重入
-- （CREATE TABLE 非 IF NOT EXISTS，裸跑两次会报错——幂等须经 npm run migrate；与 0006 注释口径一致）。
CREATE TABLE "ai_experiences" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"canonical_source_url" text NOT NULL,
	"representative_raw_item_id" bigint NOT NULL,
	"scenario" text,
	"tools" jsonb,
	"techniques" text,
	"applicability" text,
	"long_term_value" integer NOT NULL,
	"headline_zh" text,
	"summary_zh" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ai_experiences_canonical_source_url_key" UNIQUE("canonical_source_url")
);
