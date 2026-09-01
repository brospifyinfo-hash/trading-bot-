CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_key" text NOT NULL,
	"token_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"score_engine_version" text NOT NULL,
	"decision_kind" text NOT NULL,
	"final_score" smallint,
	"data_completeness" double precision NOT NULL,
	"feature_snapshot_id" uuid NOT NULL,
	"branch_count" integer DEFAULT 0 NOT NULL,
	"source_type" text DEFAULT 'LIVE' NOT NULL,
	"is_test_fixture" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_fixture_flag" CHECK (is_test_fixture = (source_type = 'TEST_FIXTURE')),
	CONSTRAINT "decisions_completeness" CHECK (data_completeness between 0 and 1),
	CONSTRAINT "decisions_branches" CHECK (branch_count between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "feature_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"feature_name" text NOT NULL,
	"value_num" double precision,
	"value_bool" boolean,
	"value_text" text,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"observed_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"data_age_ms" integer,
	"source_tier" text NOT NULL,
	"data_quality" double precision NOT NULL,
	"decision_safety" text NOT NULL,
	"schema_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"snapshot_id" uuid,
	"decision_id" uuid,
	"decision_timestamp" timestamp with time zone,
	"source_type" text DEFAULT 'LIVE' NOT NULL,
	"is_test_fixture" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_obs_one_value" CHECK ((value_num is not null)::int + (value_bool is not null)::int + (value_text is not null)::int = 1),
	CONSTRAINT "feature_obs_causality" CHECK (observed_at is null or observed_at <= received_at),
	CONSTRAINT "feature_obs_no_lookahead" CHECK (decision_timestamp is null or observed_at is null or observed_at <= decision_timestamp),
	CONSTRAINT "feature_obs_safety_needs_timestamp" CHECK (observed_at is not null or decision_safety = 'RESEARCH_ONLY'),
	CONSTRAINT "feature_obs_fixture_is_research_only" CHECK (not is_test_fixture or decision_safety = 'RESEARCH_ONLY'),
	CONSTRAINT "feature_obs_fixture_flag" CHECK (is_test_fixture = (source_type = 'TEST_FIXTURE')),
	CONSTRAINT "feature_obs_quality_range" CHECK (data_quality between 0 and 1),
	CONSTRAINT "feature_obs_age_needs_timestamp" CHECK ((observed_at is null) = (data_age_ms is null))
);
--> statement-breakpoint
CREATE TABLE "provider_capability_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"capability" text NOT NULL,
	"state" text DEFAULT 'CONFIGURED' NOT NULL,
	"implementation_confidence" text DEFAULT 'NONE' NOT NULL,
	"production_verified" boolean DEFAULT false NOT NULL,
	"last_smoke_test_at" timestamp with time zone,
	"last_smoke_test_status" integer,
	"last_smoke_test_detail" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_capability_production_needs_smoke_test" CHECK (not production_verified or (last_smoke_test_at is not null and last_smoke_test_status between 200 and 299)),
	CONSTRAINT "provider_capability_ready_needs_schema" CHECK (state not in ('CAPABILITY_READY','PRODUCTION_ENABLED') or implementation_confidence = 'SCHEMA_VERIFIED'),
	CONSTRAINT "provider_capability_enabled_needs_verification" CHECK (state <> 'PRODUCTION_ENABLED' or production_verified)
);
--> statement-breakpoint
CREATE TABLE "provider_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"capability" text NOT NULL,
	"endpoint" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"latency_ms" integer NOT NULL,
	"http_status" integer,
	"success" boolean NOT NULL,
	"failure_class" text,
	"failure_reason" text,
	"cost_units" double precision,
	"tokens_covered" integer DEFAULT 1 NOT NULL,
	"token_id" uuid,
	"pipeline_stage" text,
	"decision_id" uuid,
	"schema_valid" boolean,
	CONSTRAINT "provider_requests_latency_nonnegative" CHECK (latency_ms >= 0),
	CONSTRAINT "provider_requests_tokens_positive" CHECK (tokens_covered >= 1),
	CONSTRAINT "provider_requests_failure_has_reason" CHECK (success or failure_class is not null)
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "decision_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_feature_snapshot_id_feature_snapshots_id_fk" FOREIGN KEY ("feature_snapshot_id") REFERENCES "public"."feature_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_observations" ADD CONSTRAINT "feature_observations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_observations" ADD CONSTRAINT "feature_observations_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_key" ON "decisions" USING btree ("decision_key");--> statement-breakpoint
CREATE INDEX "decisions_token_time_idx" ON "decisions" USING btree ("token_id","decided_at");--> statement-breakpoint
CREATE INDEX "decisions_fixture_idx" ON "decisions" USING btree ("is_test_fixture","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_id_fixture" ON "decisions" USING btree ("id","is_test_fixture");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_obs_dedupe" ON "feature_observations" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "feature_obs_pit_idx" ON "feature_observations" USING btree ("token_id","feature_name","observed_at");--> statement-breakpoint
CREATE INDEX "feature_obs_provider_idx" ON "feature_observations" USING btree ("provider","received_at");--> statement-breakpoint
CREATE INDEX "feature_obs_decision_idx" ON "feature_observations" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "feature_obs_snapshot_idx" ON "feature_observations" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "feature_obs_fixture_idx" ON "feature_observations" USING btree ("is_test_fixture","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_capability_unique" ON "provider_capability_status" USING btree ("provider_id","capability");--> statement-breakpoint
CREATE INDEX "provider_capability_state_idx" ON "provider_capability_status" USING btree ("state");--> statement-breakpoint
CREATE INDEX "provider_requests_provider_idx" ON "provider_requests" USING btree ("provider_id","at");--> statement-breakpoint
CREATE INDEX "provider_requests_capability_idx" ON "provider_requests" USING btree ("capability","at");--> statement-breakpoint
CREATE INDEX "provider_requests_decision_idx" ON "provider_requests" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "opportunities_decision_idx" ON "opportunities" USING btree ("decision_id");