CREATE TABLE "paper_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"entry_score" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "paper_settings_singleton" CHECK ("paper_settings"."id" = 'singleton'),
	CONSTRAINT "paper_settings_entry_score" CHECK ("paper_settings"."entry_score" BETWEEN 10 AND 95)
);
