CREATE TABLE "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claimed_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"last_error" text,
	"last_failure_class" text,
	"result" jsonb,
	CONSTRAINT "job_queue_attempts_bounded" CHECK (attempts >= 0 and attempts <= max_attempts),
	CONSTRAINT "job_queue_running_has_lease" CHECK (state <> 'RUNNING' or (lease_until is not null and claimed_by is not null)),
	CONSTRAINT "job_queue_terminal_has_finish" CHECK (state in ('QUEUED','RUNNING') or finished_at is not null),
	CONSTRAINT "job_queue_dead_has_reason" CHECK (state <> 'DEAD' or last_error is not null)
);
--> statement-breakpoint
CREATE TABLE "job_queue_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "job_queue_ready_idx" ON "job_queue" USING btree ("state","run_after","priority");--> statement-breakpoint
CREATE INDEX "job_queue_lease_idx" ON "job_queue" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "job_queue_kind_idx" ON "job_queue" USING btree ("kind","enqueued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_queue_history_key" ON "job_queue_history" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "job_queue_history_kind_idx" ON "job_queue_history" USING btree ("kind","finished_at");--> statement-breakpoint
-- Ein offener Auftrag je fachlichem Schluessel.
--
-- Teilweise, weil abgeschlossene Auftraege den Schluessel nicht dauerhaft
-- belegen duerfen: sonst koennte derselbe Takt morgen nicht mehr laufen.
-- Die Wiederholungssperre fuer bereits erledigte Vorgaenge traegt
-- job_queue_history, nicht dieser Index.
CREATE UNIQUE INDEX "job_queue_open_key" ON "job_queue" USING btree ("dedupe_key")
  WHERE state IN ('QUEUED', 'RUNNING');
