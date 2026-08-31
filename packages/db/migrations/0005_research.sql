CREATE TABLE "candidate_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"train_from" timestamp with time zone NOT NULL,
	"train_to" timestamp with time zone NOT NULL,
	"oos_from" timestamp with time zone NOT NULL,
	"oos_to" timestamp with time zone NOT NULL,
	"embargo_seconds" integer NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"boundary_hash" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'HYPOTHESIS' NOT NULL,
	"origin" text NOT NULL,
	"research_batch_id" uuid NOT NULL,
	"base_strategy_version_id" uuid NOT NULL,
	"hypothesis" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"hypothesis_at" timestamp with time zone NOT NULL,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_transitions" ADD CONSTRAINT "candidate_transitions_candidate_id_strategy_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."strategy_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_candidates" ADD CONSTRAINT "strategy_candidates_research_batch_id_research_batches_id_fk" FOREIGN KEY ("research_batch_id") REFERENCES "public"."research_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_candidates" ADD CONSTRAINT "strategy_candidates_base_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("base_strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_transitions_candidate_idx" ON "candidate_transitions" USING btree ("candidate_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_batches_boundary_hash" ON "research_batches" USING btree ("boundary_hash");--> statement-breakpoint
CREATE INDEX "research_batches_train_idx" ON "research_batches" USING btree ("train_from","train_to");--> statement-breakpoint
CREATE INDEX "strategy_candidates_state_idx" ON "strategy_candidates" USING btree ("state");--> statement-breakpoint
CREATE INDEX "strategy_candidates_batch_idx" ON "strategy_candidates" USING btree ("research_batch_id");--> statement-breakpoint
-- Eingefrorene Zeitgrenzen und Zustandswechsel sind Beweise, keine Bewertungen.
-- Eine nachtraeglich verschobene Grenze waere nicht nur ein Fehler, sie waere
-- unbemerkbar (I-6); ein nachtraeglich gesetzter Zustandswechsel ebenso.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_app') THEN
    REVOKE UPDATE, DELETE ON research_batches FROM sae_app;
    REVOKE UPDATE, DELETE ON candidate_transitions FROM sae_app;
  END IF;
END $$;
