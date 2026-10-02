ALTER TABLE "paper_settings" ADD COLUMN "max_market_cap_usd" bigint DEFAULT 5000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_settings" ADD COLUMN "max_coin_age_minutes" integer;--> statement-breakpoint
ALTER TABLE "paper_settings" ADD CONSTRAINT "paper_settings_max_market_cap" CHECK ("paper_settings"."max_market_cap_usd" > 0);--> statement-breakpoint
ALTER TABLE "paper_settings" ADD CONSTRAINT "paper_settings_max_coin_age" CHECK ("paper_settings"."max_coin_age_minutes" IS NULL OR "paper_settings"."max_coin_age_minutes" > 0);
