ALTER TABLE "feature_snapshots" ADD COLUMN "source_type" text DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD COLUMN "source_provider" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD COLUMN "source_tier" text;--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD COLUMN "source_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD COLUMN "is_test_fixture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "source_type" text DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "is_test_fixture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "source_type" text DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "is_test_fixture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_snapshots_id_fixture" ON "feature_snapshots" USING btree ("id","is_test_fixture");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_id_fixture" ON "opportunities" USING btree ("id","is_test_fixture");--> statement-breakpoint
CREATE INDEX "opportunities_fixture_idx" ON "opportunities" USING btree ("is_test_fixture","stream");--> statement-breakpoint
CREATE INDEX "paper_positions_fixture_idx" ON "paper_positions" USING btree ("is_test_fixture","stream");--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD CONSTRAINT "feature_snapshots_fixture_flag" CHECK (is_test_fixture = (source_type = 'TEST_FIXTURE'));--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD CONSTRAINT "feature_snapshots_fixture_labelled" CHECK (not is_test_fixture or source_provider like 'TEST_FIXTURE:%');--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_fixture_flag" CHECK (is_test_fixture = (source_type = 'TEST_FIXTURE'));--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_fixture_flag" CHECK (is_test_fixture = (source_type = 'TEST_FIXTURE'));--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_snapshot_fixture_fk" FOREIGN KEY ("feature_snapshot_id","is_test_fixture") REFERENCES "public"."feature_snapshots"("id","is_test_fixture") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_opportunity_fixture_fk" FOREIGN KEY ("opportunity_id","is_test_fixture") REFERENCES "public"."opportunities"("id","is_test_fixture") ON DELETE no action ON UPDATE no action;