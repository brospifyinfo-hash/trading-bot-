ALTER TABLE "paper_settings" ADD COLUMN "entry_notional_minor" bigint;--> statement-breakpoint
ALTER TABLE "paper_settings" ADD CONSTRAINT "paper_settings_entry_notional" CHECK ("paper_settings"."entry_notional_minor" IS NULL OR "paper_settings"."entry_notional_minor" > 0);
