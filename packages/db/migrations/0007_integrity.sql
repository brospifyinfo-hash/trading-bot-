DROP INDEX "latency_samples_opportunity_idx";--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_snapshots_unique" ON "feature_snapshots" USING btree ("token_id","observed_at","score_engine_version");--> statement-breakpoint
CREATE UNIQUE INDEX "latency_samples_opportunity" ON "latency_samples" USING btree ("opportunity_id");--> statement-breakpoint
ALTER TABLE "feature_snapshots" ADD CONSTRAINT "feature_snapshots_completeness" CHECK (data_completeness between 0 and 1);--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_respond_after_decision" CHECK (respond_by is null or respond_by > decided_at);--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_closed_after_decision" CHECK (closed_at is null or closed_at >= decided_at);--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_remaining_range" CHECK (remaining_amount_raw >= 0 and remaining_amount_raw <= entry_amount_raw);--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_notional_positive" CHECK (entry_notional_minor > 0);--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_closed_order" CHECK (closed_at is null or closed_at >= opened_at);--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_closed_has_reason" CHECK (closed_at is null or exit_reason is not null);--> statement-breakpoint
-- Ein Preis von null oder negativ ist kein Preis. Ihn zu speichern hiesse, dem
-- PitReader eine Beobachtung zu geben, die er spaeter als gueltig ausliefert.
ALTER TABLE "token_snapshots" ADD CONSTRAINT "token_snapshots_price_positive"
  CHECK (price_usd is null or price_usd > 0);--> statement-breakpoint
-- Eine negative Reaktionszeit entsteht nur durch Uhrendrift und wuerde jede
-- Latenzauswertung verzerren.
ALTER TABLE "manual_responses" ADD CONSTRAINT "manual_responses_duration_nonnegative"
  CHECK (response_ms >= 0);
