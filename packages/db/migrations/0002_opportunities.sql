CREATE TABLE "feature_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"features" jsonb NOT NULL,
	"missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_completeness" double precision NOT NULL,
	"score_engine_version" text NOT NULL,
	"feature_set_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"response_ms" integer NOT NULL,
	"price_at_response_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"state" text DEFAULT 'OFFERED' NOT NULL,
	"decision_kind" text NOT NULL,
	"final_score" smallint,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feature_snapshot_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"respond_by" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opportunity_outcomes" (
	"opportunity_id" uuid PRIMARY KEY NOT NULL,
	"reference_price_usd" double precision NOT NULL,
	"return_5m" double precision,
	"return_15m" double precision,
	"return_30m" double precision,
	"return_1h" double precision,
	"return_4h" double precision,
	"hypothetical_mfe" double precision,
	"hypothetical_mae" double precision,
	"observed_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_position_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"sizing_mode" text NOT NULL,
	"entry_notional_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"entry_amount_raw" bigint NOT NULL,
	"remaining_amount_raw" bigint NOT NULL,
	"realized_pnl_minor" bigint DEFAULT 0 NOT NULL,
	"costs_paid_minor" bigint DEFAULT 0 NOT NULL,
	"max_adverse_excursion" double precision,
	"max_favorable_excursion" double precision,
	"exit_efficiency" double precision,
	"strategy_version_id" uuid NOT NULL,
	"exit_reason" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "paper_positions_opportunity_id_unique" UNIQUE("opportunity_id")
);
--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD CONSTRAINT "feature_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_responses" ADD CONSTRAINT "manual_responses_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_feature_snapshot_id_feature_snapshots_id_fk" FOREIGN KEY ("feature_snapshot_id") REFERENCES "public"."feature_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_outcomes" ADD CONSTRAINT "opportunity_outcomes_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_position_events" ADD CONSTRAINT "paper_position_events_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_snapshots_pit_idx" ON "feature_snapshots" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "feature_snapshots_hash_idx" ON "feature_snapshots" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "manual_responses_opportunity_idx" ON "manual_responses" USING btree ("opportunity_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_unique" ON "opportunities" USING btree ("token_id","stream","decided_at");--> statement-breakpoint
CREATE INDEX "opportunities_state_idx" ON "opportunities" USING btree ("state");--> statement-breakpoint
CREATE INDEX "opportunities_stream_time_idx" ON "opportunities" USING btree ("stream","decided_at");--> statement-breakpoint
CREATE INDEX "opportunities_respond_by_idx" ON "opportunities" USING btree ("respond_by") WHERE state in ('OFFERED','SEEN');--> statement-breakpoint
CREATE INDEX "paper_position_events_pos_idx" ON "paper_position_events" USING btree ("position_id","at");--> statement-breakpoint
CREATE INDEX "paper_positions_stream_idx" ON "paper_positions" USING btree ("stream","sizing_mode","opened_at");--> statement-breakpoint
CREATE INDEX "paper_positions_open_idx" ON "paper_positions" USING btree ("closed_at");--> statement-breakpoint
-- Schreibschutz fuer eingefrorene Entscheidungsdaten (Spec §83, §115).
--
-- Ein Kommentar „bitte nicht aendern" haelt genau so lange, bis jemand unter
-- Zeitdruck ein Feld nachtraegt. Danach passt die Historie zum Ergebnis statt
-- umgekehrt, und keine Auswertung darueber ist noch etwas wert.
--
-- Die Anwendungsrolle darf einfuegen und lesen, aber nicht aendern oder loeschen.
-- Korrekturen laufen ueber eine neue Zeile mit neuer Version, nie ueber ein UPDATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_app') THEN
    REVOKE UPDATE, DELETE ON feature_snapshots FROM sae_app;
    REVOKE UPDATE, DELETE ON manual_responses FROM sae_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_ro') THEN
    REVOKE UPDATE, DELETE, INSERT ON ALL TABLES IN SCHEMA public FROM sae_ro;
  END IF;
END
$$;
