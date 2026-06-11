CREATE TABLE "ai_products" (
	"product_id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" varchar(255) NOT NULL,
	"canonical_domain" varchar(255),
	"github_repo" varchar(255),
	"product_hunt_slug" varchar(255),
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_pushed_at" timestamp with time zone,
	"metadata" jsonb,
	"representative_raw_item_id" bigint,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ai_products_canonical_domain_key" UNIQUE("canonical_domain"),
	CONSTRAINT "ai_products_github_repo_key" UNIQUE("github_repo"),
	CONSTRAINT "ai_products_product_hunt_slug_key" UNIQUE("product_hunt_slug")
);
--> statement-breakpoint
ALTER TABLE "ai_news_events" ADD COLUMN "judge_claimed_at" timestamp with time zone;