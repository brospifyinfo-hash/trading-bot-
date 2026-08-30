CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"two_factor_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_secret" text NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pubkey" text NOT NULL,
	"role" text NOT NULL,
	"label" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_pubkey_unique" UNIQUE("pubkey")
);
--> statement-breakpoint
CREATE TABLE "price_observations" (
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"price_usd" double precision NOT NULL,
	"liquidity_usd" double precision,
	"base_reserve" bigint,
	"quote_reserve" bigint,
	"source" text NOT NULL,
	CONSTRAINT "price_observations_token_id_observed_at_source_pk" PRIMARY KEY("token_id","observed_at","source")
);
--> statement-breakpoint
CREATE TABLE "token_narratives" (
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"narrative" text NOT NULL,
	"confidence" double precision NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"raw_features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "token_narratives_token_id_observed_at_narrative_pk" PRIMARY KEY("token_id","observed_at","narrative")
);
--> statement-breakpoint
CREATE TABLE "token_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"address" text NOT NULL,
	"dex" text NOT NULL,
	"base_mint" text NOT NULL,
	"quote_mint" text NOT NULL,
	"fee_bps" integer NOT NULL,
	"created_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_pools_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "token_security" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"check_version" text NOT NULL,
	"mint_authority_active" boolean,
	"freeze_authority_active" boolean,
	"token_program" text,
	"has_transfer_hook" boolean,
	"transfer_fee_bps" integer,
	"lp_burned_or_locked" boolean,
	"lp_locked_until" timestamp with time zone,
	"top_holder_share_pct" double precision,
	"top10_holder_share_pct" double precision,
	"dev_holding_pct" double precision,
	"risk_level" text,
	"security_score" smallint,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_ts" timestamp with time zone,
	"price_usd" double precision,
	"market_cap_usd" double precision,
	"liquidity_usd" double precision,
	"volume_24h_usd" double precision,
	"holders" integer,
	"buys_5m" integer,
	"sells_5m" integer,
	"security_score" smallint,
	"liquidity_score" smallint,
	"momentum_score" smallint,
	"smart_money_score" smallint,
	"social_score" smallint,
	"dev_score" smallint,
	"holder_score" smallint,
	"narrative_score" smallint,
	"manipulation_score" smallint,
	"execution_score" smallint,
	"final_score" smallint,
	"data_completeness" double precision NOT NULL,
	"missing_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score_engine_version" text
);
--> statement-breakpoint
CREATE TABLE "token_social" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"platform" text NOT NULL,
	"handle" text,
	"account_created_at" timestamp with time zone,
	"followers" integer,
	"following" integer,
	"posts" integer,
	"engagement_rate" double precision,
	"authenticity_score" smallint,
	"momentum_score" smallint,
	"anomalies" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_wallet_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"total_holders" integer,
	"distinct_actors" integer,
	"cluster_count" integer,
	"largest_cluster_share_pct" double precision,
	"smart_money_buyers" integer,
	"smart_money_sellers" integer,
	"cluster_method_version" text
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mint" text NOT NULL,
	"symbol" text,
	"name" text,
	"decimals" smallint NOT NULL,
	"state" text DEFAULT 'DISCOVERED' NOT NULL,
	"blacklisted_at" timestamp with time zone,
	"blacklist_reason" text,
	"discovery_source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone,
	CONSTRAINT "tokens_mint_unique" UNIQUE("mint")
);
--> statement-breakpoint
CREATE TABLE "dev_wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"launch_count" integer,
	"rug_count" integer,
	"realized_pnl_usd" double precision,
	"median_token_lifetime_seconds" integer,
	"behaviour_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dev_score" integer
);
--> statement-breakpoint
CREATE TABLE "smart_money_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"qualified_at" timestamp with time zone NOT NULL,
	"disqualified_at" timestamp with time zone,
	"method_version" text NOT NULL,
	"realized_pnl_usd" double precision,
	"win_rate" double precision,
	"trade_count" integer,
	"avg_return_pct" double precision,
	"early_entry_rate" double precision,
	"median_hold_seconds" integer,
	"score" integer
);
--> statement-breakpoint
CREATE TABLE "wallet_cluster_members" (
	"cluster_id" uuid NOT NULL,
	"address" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	CONSTRAINT "wallet_cluster_members_cluster_id_address_pk" PRIMARY KEY("cluster_id","address")
);
--> statement-breakpoint
CREATE TABLE "wallet_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"method_version" text NOT NULL,
	"token_id" uuid,
	"member_count" integer NOT NULL,
	"confidence" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_labels" (
	"address" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"exclude_from_clustering" text DEFAULT 'true' NOT NULL,
	"source" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"signature" text NOT NULL,
	"side" text NOT NULL,
	"amount_raw" bigint NOT NULL,
	"sol_value_lamports" bigint,
	"block_time" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"features" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"provider_set_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"final_score" smallint,
	"strategy_version_id" uuid,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"security" smallint,
	"liquidity" smallint,
	"momentum" smallint,
	"smart_money" smallint,
	"social" smallint,
	"dev" smallint,
	"holder" smallint,
	"narrative" smallint,
	"manipulation" smallint,
	"execution" smallint,
	"final_score" smallint NOT NULL,
	"score_engine_version" text NOT NULL,
	"input_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"final_score" smallint NOT NULL,
	"risk_level" text NOT NULL,
	"ev_kind" text NOT NULL,
	"ev_per_unit" double precision,
	"ev_confidence" double precision,
	"ev_sample_size" integer,
	"data_completeness" double precision NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score_engine_version" text NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"reason" text NOT NULL,
	"backtest_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"retired_at" timestamp with time zone,
	CONSTRAINT "strategy_versions_unique" UNIQUE("strategy_id","version")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"order_id" uuid,
	"state" text NOT NULL,
	"quote_in_amount" bigint,
	"quote_out_amount" bigint,
	"min_out_amount" bigint,
	"price_impact_bps" integer,
	"route_label" text,
	"quoted_at" timestamp with time zone,
	"network_fee_lamports" bigint,
	"priority_fee_lamports" bigint,
	"tip_lamports" bigint,
	"estimated_cost_minor" bigint,
	"actual_cost_minor" bigint,
	"realized_slippage_bps" integer,
	"execution_delay_ms" integer,
	"signature" text,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_amount_raw" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"virtual_capital_minor" bigint NOT NULL,
	"cost_breakdown" jsonb NOT NULL,
	"cost_model_version" text NOT NULL,
	"assumed_latency_ms" integer NOT NULL,
	"assumed_failure_rate" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"mode" text NOT NULL,
	"origin" text NOT NULL,
	"wallet_id" uuid,
	"state" text NOT NULL,
	"entry_amount_raw" bigint NOT NULL,
	"remaining_amount_raw" bigint NOT NULL,
	"entry_notional_minor" bigint NOT NULL,
	"realized_pnl_minor" bigint DEFAULT 0 NOT NULL,
	"costs_paid_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"stop_loss_bps" integer NOT NULL,
	"trailing_stop_bps" integer,
	"high_water_mark_price" double precision,
	"strategy_version_id" uuid NOT NULL,
	"score_engine_version" text,
	"entry_final_score" smallint,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "take_profits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"level_index" integer NOT NULL,
	"trigger_gain_bps" integer NOT NULL,
	"sell_portion_bps" integer NOT NULL,
	"hit_at" timestamp with time zone,
	"sold_amount_raw" bigint
);
--> statement-breakpoint
CREATE TABLE "trade_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"mode" text NOT NULL,
	"origin" text NOT NULL,
	"side" text NOT NULL,
	"state" text DEFAULT 'INTENT_CREATED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"planned_notional_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"max_slippage_bps" integer NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trade_intents_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"token_id" uuid,
	"dedup_key" text NOT NULL,
	"final_score" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"code_commit_hash" text NOT NULL,
	"cost_model_version" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"phase" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"token_id" uuid,
	"entry_at" timestamp with time zone NOT NULL,
	"exit_at" timestamp with time zone,
	"net_pnl_minor" bigint,
	"costs_minor" bigint,
	"exit_reason" text
);
--> statement-breakpoint
CREATE TABLE "circuit_breaker_state" (
	"name" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'CLOSED' NOT NULL,
	"opened_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"template" text NOT NULL,
	"to_address" text NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "manual_trade_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"error_rate" double precision,
	"budget_used_pct" double precision,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid,
	"signature" text,
	"kind" text NOT NULL,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actual" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved" text DEFAULT 'pending' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position_id" uuid,
	"token_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_narratives" ADD CONSTRAINT "token_narratives_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_pools" ADD CONSTRAINT "token_pools_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_security" ADD CONSTRAINT "token_security_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD CONSTRAINT "token_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_social" ADD CONSTRAINT "token_social_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_wallet_metrics" ADD CONSTRAINT "token_wallet_metrics_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_cluster_members" ADD CONSTRAINT "wallet_cluster_members_cluster_id_wallet_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."wallet_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_clusters" ADD CONSTRAINT "wallet_clusters_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_inputs" ADD CONSTRAINT "decision_inputs_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_intent_id_trade_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."trade_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intent_id_trade_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."trade_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "take_profits" ADD CONSTRAINT "take_profits_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_alerts" ADD CONSTRAINT "email_alerts_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_trade_tokens" ADD CONSTRAINT "manual_trade_tokens_intent_id_trade_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."trade_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_events" ADD CONSTRAINT "reconciliation_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_events" ADD CONSTRAINT "system_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "token_pools_token_idx" ON "token_pools" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "token_security_pit_idx" ON "token_security" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "token_snapshots_pit_idx" ON "token_snapshots" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "token_snapshots_observed_idx" ON "token_snapshots" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "token_social_pit_idx" ON "token_social" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "token_wallet_metrics_pit_idx" ON "token_wallet_metrics" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "tokens_state_idx" ON "tokens" USING btree ("state");--> statement-breakpoint
CREATE INDEX "tokens_first_seen_idx" ON "tokens" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "smart_money_qualified_idx" ON "smart_money_wallets" USING btree ("qualified_at");--> statement-breakpoint
CREATE INDEX "smart_money_address_idx" ON "smart_money_wallets" USING btree ("address");--> statement-breakpoint
CREATE INDEX "wallet_clusters_token_idx" ON "wallet_clusters" USING btree ("token_id","computed_at");--> statement-breakpoint
CREATE INDEX "wallet_tx_wallet_time_idx" ON "wallet_transactions" USING btree ("wallet","block_time");--> statement-breakpoint
CREATE INDEX "wallet_tx_mint_idx" ON "wallet_transactions" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "wallet_tx_sig_idx" ON "wallet_transactions" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "rejections_reason_idx" ON "rejections" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "rejections_time_idx" ON "rejections" USING btree ("rejected_at");--> statement-breakpoint
CREATE INDEX "scores_pit_idx" ON "scores" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "signals_token_time_idx" ON "signals" USING btree ("token_id","decided_at");--> statement-breakpoint
CREATE INDEX "signals_kind_idx" ON "signals" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "executions_intent_idx" ON "executions" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "executions_sig_idx" ON "executions" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "position_events_pos_idx" ON "position_events" USING btree ("position_id","at");--> statement-breakpoint
CREATE INDEX "positions_state_idx" ON "positions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "positions_mode_idx" ON "positions" USING btree ("mode","opened_at");--> statement-breakpoint
CREATE INDEX "positions_token_idx" ON "positions" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_intents_one_active_per_mint" ON "trade_intents" USING btree ("token_id","mode") WHERE state in ('INTENT_CREATED','PRE_TRADE_VALIDATION','QUOTED','SIGNING','SUBMITTED','UNKNOWN','RECONCILING');--> statement-breakpoint
CREATE INDEX "trade_intents_state_idx" ON "trade_intents" USING btree ("state");--> statement-breakpoint
CREATE INDEX "alerts_dedup_idx" ON "alerts" USING btree ("dedup_key","created_at");--> statement-breakpoint
CREATE INDEX "backtest_trades_run_idx" ON "backtest_trades" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "manual_trade_tokens_intent_idx" ON "manual_trade_tokens" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "provider_health_idx" ON "provider_health" USING btree ("provider","observed_at");--> statement-breakpoint
CREATE INDEX "reconciliation_time_idx" ON "reconciliation_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "risk_events_time_idx" ON "risk_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "system_events_time_idx" ON "system_events" USING btree ("at");