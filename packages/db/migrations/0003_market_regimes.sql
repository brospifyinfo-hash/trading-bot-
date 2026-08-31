CREATE TABLE "market_regimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regime" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"votes" jsonb NOT NULL,
	"missing_indicators" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_regimes_observed_at" ON "market_regimes" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "market_regimes_regime_idx" ON "market_regimes" USING btree ("regime","observed_at");--> statement-breakpoint
-- Regime-Labels sind Beobachtungen, keine Bewertungen: ein nachtraeglich
-- geaenderter Eintrag waere Look-Ahead, der wie eine Erkenntnis aussieht (I-3).
-- Die Rollenpruefung haelt Tests gegen PGlite lauffaehig, wo es keine Rollen gibt.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_app') THEN
    REVOKE UPDATE, DELETE ON market_regimes FROM sae_app;
  END IF;
END $$;
