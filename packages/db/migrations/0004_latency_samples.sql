CREATE TABLE "latency_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"observed_at" timestamp with time zone,
	"ingested_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"quoted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "latency_samples" ADD CONSTRAINT "latency_samples_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "latency_samples_opportunity_idx" ON "latency_samples" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "latency_samples_stream_idx" ON "latency_samples" USING btree ("stream","decided_at");--> statement-breakpoint
-- Gemessene Zeiten sind Beobachtungen. Nachtraeglich korrigiert waere jede
-- Latenzauswertung wertlos, und die Manual-Simulation (I-9) laege daneben.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_app') THEN
    REVOKE UPDATE, DELETE ON latency_samples FROM sae_app;
  END IF;
END $$;
