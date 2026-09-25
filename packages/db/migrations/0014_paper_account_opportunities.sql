DROP INDEX "opportunities_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_unique" ON "opportunities" USING btree ("token_id", "stream", "decided_at", "strategy_version_id");
