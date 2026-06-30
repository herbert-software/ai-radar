-- add-model-radar-price-state-and-periods（Group A）：Model Radar availability + 季/年付周期价地基。
--
-- 本迁移只改 mr_* bounded domain：
-- - mr_plans.availability：默认 unknown、NOT NULL；既有行统一补 unknown，不据价格/confidence 臆断 on_sale。
-- - mr_plan_prices：月价之外的 quarterly/annual 周期价行；plan_id 裸 varchar(128)，不建 FK/CHECK/pg-enum。
-- - current_price(月) 不动，仍是 canonical 月价 SOT。
--
-- 这份 SQL 可裸跑重入：ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT EXISTS + guarded constraint。
ALTER TABLE "mr_plans" ADD COLUMN IF NOT EXISTS "availability" text;
--> statement-breakpoint
UPDATE "mr_plans" SET "availability" = 'unknown' WHERE "availability" IS NULL;
--> statement-breakpoint
ALTER TABLE "mr_plans" ALTER COLUMN "availability" SET DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "mr_plans" ALTER COLUMN "availability" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mr_plan_prices" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"billing_period" text NOT NULL,
	"price" numeric(12, 2),
	"currency" varchar(3) NOT NULL,
	"source_url" text NOT NULL,
	"last_checked" timestamp with time zone NOT NULL,
	"source_confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_plan_prices_plan_id_billing_period_currency_key" UNIQUE("plan_id","billing_period","currency")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"mr_plan_prices"'::regclass
      AND conname = 'mr_plan_prices_plan_id_billing_period_currency_key'
  ) THEN
    ALTER TABLE "mr_plan_prices"
      ADD CONSTRAINT "mr_plan_prices_plan_id_billing_period_currency_key"
      UNIQUE ("plan_id","billing_period","currency");
  END IF;
END $$;
