ALTER TABLE "paper_positions" ADD COLUMN "close_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "close_requested_by" text;
