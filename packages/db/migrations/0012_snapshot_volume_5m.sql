ALTER TABLE "token_snapshots" ADD COLUMN "volume_5m_usd" double precision;
--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "price_impact_bps" double precision;