import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Kanonische Identitaet. Verhindert Dubletten aus mehreren Discovery-Quellen. */
    mint: text("mint").notNull().unique(),
    symbol: text("symbol"),
    name: text("name"),
    decimals: smallint("decimals").notNull(),
    state: text("state", {
      enum: [
        "DISCOVERED",
        "SCREENING",
        "ENRICHING",
        "SCORED",
        "CANDIDATE",
        "WATCHLIST",
        "DECIDED",
        "REJECTED",
      ],
    })
      .notNull()
      .default("DISCOVERED"),
    /** Terminal: ein CRITICAL-Sicherheitsbefund wird nie erneut gehandelt. */
    blacklistedAt: timestamp("blacklisted_at", { withTimezone: true }),
    blacklistReason: text("blacklist_reason"),
    discoverySource: text("discovery_source").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
  },
  (t) => [index("tokens_state_idx").on(t.state), index("tokens_first_seen_idx").on(t.firstSeenAt)],
);

export const tokenPools = pgTable(
  "token_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    address: text("address").notNull().unique(),
    dex: text("dex").notNull(),
    baseMint: text("base_mint").notNull(),
    quoteMint: text("quote_mint").notNull(),
    feeBps: integer("fee_bps").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("token_pools_token_idx").on(t.tokenId)],
);

/**
 * Zeitreihe des bekannten Token-Zustands.
 *
 * `observedAt` ist der Zeitpunkt, zu dem WIR den Zustand gesehen haben, und der
 * einzige Zeitstempel, auf den ein Backtest filtern darf. `sourceTs` ist rein
 * informativ — ein Provider kann Daten liefern, die er selbst frueher datiert;
 * gewusst haben wir sie trotzdem erst zu `observedAt`.
 *
 * In Produktion ist diese Tabelle eine Timescale-Hypertable (siehe
 * optional/timescale.sql). Ohne die Extension laeuft sie als normale
 * Tabelle mit demselben Index — nur langsamer.
 */
export const tokenSnapshots = pgTable(
  "token_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceTs: timestamp("source_ts", { withTimezone: true }),

    priceUsd: doublePrecision("price_usd"),
    marketCapUsd: doublePrecision("market_cap_usd"),
    liquidityUsd: doublePrecision("liquidity_usd"),
    volume24hUsd: doublePrecision("volume_24h_usd"),
    holders: integer("holders"),
    buys5m: integer("buys_5m"),
    sells5m: integer("sells_5m"),

    securityScore: smallint("security_score"),
    liquidityScore: smallint("liquidity_score"),
    momentumScore: smallint("momentum_score"),
    smartMoneyScore: smallint("smart_money_score"),
    socialScore: smallint("social_score"),
    devScore: smallint("dev_score"),
    holderScore: smallint("holder_score"),
    narrativeScore: smallint("narrative_score"),
    manipulationScore: smallint("manipulation_score"),
    executionScore: smallint("execution_score"),
    finalScore: smallint("final_score"),

    /** Anteil tatsaechlich vorhandener Inputs, 0..1. */
    dataCompleteness: doublePrecision("data_completeness").notNull(),
    /** Welche Felder fehlten und warum — Grundlage der Datenqualitaetsforschung. */
    missingInputs: jsonb("missing_inputs").notNull().default({}),
    scoreEngineVersion: text("score_engine_version"),

    /**
     * Herkunft dieses Snapshots.
     *
     * Ohne diese vier Spalten laesst sich spaeter nicht sagen, ob eine
     * Entscheidung auf Primaerdaten oder auf einem Fallback beruhte — und dann
     * ist jede Auswertung nach Datenqualitaet unmoeglich. `source_tier` ist die
     * SCHLECHTESTE beteiligte Stufe: ein Datensatz mit Preis vom Primaer- und
     * Liquiditaet vom Fallback-Anbieter ist kein Primaerdatensatz.
     */
    sourceProviderId: text("source_provider_id"),
    sourceTier: text("source_tier", { enum: ["PRIMARY", "SECONDARY", "FALLBACK"] }),
    /** Alter der Beobachtung beim Abruf, in Sekunden. */
    sourceFreshnessSeconds: doublePrecision("source_freshness_seconds"),
    /** Alle beteiligten Anbieter mit ihrer Stufe. */
    sourceContributors: jsonb("source_contributors").notNull().default([]),

    /**
     * Stabiler Schluessel des Datenpunkts.
     *
     * Macht die Aufnahme idempotent: derselbe Anbieter, derselbe Token,
     * dieselbe Beobachtungssekunde ergeben denselben Schluessel — und die
     * Datenbank weist die zweite Zeile ab, statt sich auf die Sorgfalt des
     * Workers zu verlassen.
     */
    ingestKey: text("ingest_key"),
  },
  (t) => [
    // Der wichtigste Index des Systems: Point-in-time-Zugriff.
    index("token_snapshots_pit_idx").on(t.tokenId, t.observedAt),
    index("token_snapshots_observed_idx").on(t.observedAt),
    uniqueIndex("token_snapshots_ingest_key").on(t.ingestKey),
    index("token_snapshots_source_idx").on(t.sourceProviderId, t.observedAt),
  ],
);

export const tokenSecurity = pgTable(
  "token_security",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    checkVersion: text("check_version").notNull(),

    mintAuthorityActive: boolean("mint_authority_active"),
    freezeAuthorityActive: boolean("freeze_authority_active"),
    tokenProgram: text("token_program"),
    hasTransferHook: boolean("has_transfer_hook"),
    transferFeeBps: integer("transfer_fee_bps"),
    lpBurnedOrLocked: boolean("lp_burned_or_locked"),
    lpLockedUntil: timestamp("lp_locked_until", { withTimezone: true }),

    topHolderSharePct: doublePrecision("top_holder_share_pct"),
    top10HolderSharePct: doublePrecision("top10_holder_share_pct"),
    devHoldingPct: doublePrecision("dev_holding_pct"),

    riskLevel: text("risk_level", { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }),
    securityScore: smallint("security_score"),
    findings: jsonb("findings").notNull().default([]),
  },
  (t) => [index("token_security_pit_idx").on(t.tokenId, t.observedAt)],
);

export const tokenSocial = pgTable(
  "token_social",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    platform: text("platform").notNull(),
    handle: text("handle"),
    accountCreatedAt: timestamp("account_created_at", { withTimezone: true }),
    followers: integer("followers"),
    following: integer("following"),
    posts: integer("posts"),
    engagementRate: doublePrecision("engagement_rate"),
    /** Existenz allein ist kein positives Signal — nur Authentizitaet zaehlt. */
    authenticityScore: smallint("authenticity_score"),
    momentumScore: smallint("momentum_score"),
    anomalies: jsonb("anomalies").notNull().default([]),
  },
  (t) => [index("token_social_pit_idx").on(t.tokenId, t.observedAt)],
);

export const tokenWalletMetrics = pgTable(
  "token_wallet_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    totalHolders: integer("total_holders"),
    /** Holder nach Cluster-Bereinigung — die Zahl, die zaehlt. */
    distinctActors: integer("distinct_actors"),
    clusterCount: integer("cluster_count"),
    largestClusterSharePct: doublePrecision("largest_cluster_share_pct"),
    smartMoneyBuyers: integer("smart_money_buyers"),
    smartMoneySellers: integer("smart_money_sellers"),
    clusterMethodVersion: text("cluster_method_version"),
  },
  (t) => [index("token_wallet_metrics_pit_idx").on(t.tokenId, t.observedAt)],
);

export const tokenNarratives = pgTable(
  "token_narratives",
  {
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    narrative: text("narrative").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    /** AI liefert Features, keine Entscheidungen — Modell und Prompt sind Teil des Befunds. */
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    rawFeatures: jsonb("raw_features").notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.observedAt, t.narrative] })],
);

export const priceObservations = pgTable(
  "price_observations",
  {
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    priceUsd: doublePrecision("price_usd").notNull(),
    liquidityUsd: doublePrecision("liquidity_usd"),
    baseReserve: bigint("base_reserve", { mode: "bigint" }),
    quoteReserve: bigint("quote_reserve", { mode: "bigint" }),
    source: text("source").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.observedAt, t.source] })],
);
