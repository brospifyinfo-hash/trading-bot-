CREATE TABLE "job_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_units" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_units" integer
);
--> statement-breakpoint
CREATE TABLE "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_key" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "provider_status_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"latency_ms_p50" double precision,
	"latency_ms_p95" double precision,
	"rate_limit_remaining" integer,
	"rate_limit_limit" integer,
	"rate_limit_reset_at" timestamp with time zone,
	"data_freshness_seconds" double precision,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "source_provider_id" text;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "source_tier" text;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "source_freshness_seconds" double precision;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "source_contributors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "ingest_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "job_checkpoints_key" ON "job_checkpoints" USING btree ("job_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_executions_key" ON "job_executions" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "job_executions_open_idx" ON "job_executions" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "provider_status_provider_idx" ON "provider_status_samples" USING btree ("provider_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_status_unique" ON "provider_status_samples" USING btree ("provider_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_snapshots_ingest_key" ON "token_snapshots" USING btree ("ingest_key");--> statement-breakpoint
CREATE INDEX "token_snapshots_source_idx" ON "token_snapshots" USING btree ("source_provider_id","observed_at");--> statement-breakpoint
-- Provider-Messungen sind Beobachtungen. Eine nachtraeglich geaenderte Messung
-- wuerde die Frage „seit wann ist das gesperrt" unbeantwortbar machen.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_app') THEN
    REVOKE UPDATE, DELETE ON provider_status_samples FROM sae_app;
  END IF;
END $$;
