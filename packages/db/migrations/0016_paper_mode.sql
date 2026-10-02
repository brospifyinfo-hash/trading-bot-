ALTER TABLE "paper_settings" ADD COLUMN "mode" text DEFAULT 'VORSICHTIG' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_settings" ADD CONSTRAINT "paper_settings_mode" CHECK ("paper_settings"."mode" IN ('VORSICHTIG', 'OFFENSIV'));
