import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tokens } from "./tokens";
import { strategyVersions } from "./strategy";
import { featureSnapshots, SOURCE_TIERS, SOURCE_TYPES } from "./opportunities";

/**
 * Eine Entscheidung als eigenes Ereignis.
 *
 * Bisher gab es sie nur fluechtig: `opportunity-pipeline.ts` berechnete eine
 * Kennung und warf sie weg. Damit liess sich hinterher nicht sagen, welche
 * beiden Gelegenheiten aus DERSELBEN Entscheidung stammten — und genau das ist
 * die Frage, auf die das ganze System hinauslaeuft: haette der Mensch besser
 * entschieden als die Automatik?
 *
 * Die Entscheidung ist bewusst NICHT aus der Gelegenheit ableitbar. Eine
 * Entscheidung erzeugt zwei Gelegenheiten (Auto und Manual); die
 * Gelegenheits-ID als Entscheidungskennung zu benutzen hiesse, sich fuer eine
 * der beiden zu entscheiden und die andere zu verlieren.
 */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Fachlicher Schluessel, aus Feature-Vektor und Engine-Version berechnet.
     *
     * `UNIQUE`: derselbe Eingang ergibt dieselbe Entscheidung. Ein zweiter Lauf
     * legt keine zweite an — die Datenbank entscheidet das, nicht ein
     * vorheriges SELECT.
     */
    decisionKey: text("decision_key").notNull(),

    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),

    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    scoreEngineVersion: text("score_engine_version").notNull(),

    decisionKind: text("decision_kind", { enum: ["ENTER", "WATCH", "REJECT"] }).notNull(),
    finalScore: smallint("final_score"),
    dataCompleteness: doublePrecision("data_completeness").notNull(),

    /** Der Zustand, gegen den entschieden wurde. */
    featureSnapshotId: uuid("feature_snapshot_id")
      .notNull()
      .references(() => featureSnapshots.id, { onDelete: "restrict" }),

    /** Wie viele Stroeme daraus entstanden sind. Auto + Manual = 2. */
    branchCount: integer("branch_count").notNull().default(0),

    sourceType: text("source_type", { enum: SOURCE_TYPES }).notNull().default("LIVE"),
    isTestFixture: boolean("is_test_fixture").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("decisions_key").on(t.decisionKey),
    index("decisions_token_time_idx").on(t.tokenId, t.decidedAt),
    index("decisions_fixture_idx").on(t.isTestFixture, t.decidedAt),
    check("decisions_fixture_flag", sql`is_test_fixture = (source_type = 'TEST_FIXTURE')`),
    check("decisions_completeness", sql`data_completeness between 0 and 1`),
    check("decisions_branches", sql`branch_count between 0 and 3`),
    // Traegt den zusammengesetzten Fremdschluessel der Gelegenheit.
    uniqueIndex("decisions_id_fixture").on(t.id, t.isTestFixture),
  ],
);

export const DECISION_SAFETIES = ["DECISION_SAFE", "RESEARCH_ONLY"] as const;

/**
 * Ein beobachtetes Feature mit seiner eigenen Herkunft.
 *
 * Der Unterschied zu `token_snapshots`: dort traegt eine Zeile EINE Herkunft
 * fuer alle Felder. Hier traegt jedes Feld seine eigene — Preis von einem
 * Anbieter, Liquiditaet von einem anderen, in derselben Beobachtung. Ohne diese
 * Trennung laesst sich spaeter nicht untersuchen, welche Anbieter tatsaechlich
 * unabhaengige Evidenz liefern und welche nur dieselbe Quelle spiegeln.
 *
 * Drei getrennte Wertspalten statt `jsonb`: die Tabelle existiert fuer
 * numerische Auswertung. Ein JSON-Feld wuerde jede Perzentil- und
 * Korrelationsabfrage zu einem Cast zwingen und Indizes unbrauchbar machen.
 */
export const featureObservations = pgTable(
  "feature_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    /** Punktnotation, z. B. `market.liquidity_usd`. */
    featureName: text("feature_name").notNull(),

    valueNum: doublePrecision("value_num"),
    valueBool: boolean("value_bool"),
    valueText: text("value_text"),

    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),

    /**
     * Wann der Wert beim Anbieter galt.
     *
     * **Nullable, und das ist der Punkt.** Liefert ein Anbieter keinen
     * Beobachtungszeitpunkt, bleibt die Spalte leer — es wird keiner
     * konstruiert. Die Folge steht in `decision_safety`.
     */
    observedAt: timestamp("observed_at", { withTimezone: true }),
    /** Wann der Wert bei uns ankam. Immer bekannt. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** `null`, wenn `observed_at` fehlt — kein geschaetztes Alter. */
    dataAgeMs: integer("data_age_ms"),

    sourceTier: text("source_tier", { enum: SOURCE_TIERS }).notNull(),
    dataQuality: doublePrecision("data_quality").notNull(),
    decisionSafety: text("decision_safety", { enum: DECISION_SAFETIES }).notNull(),

    schemaVersion: text("schema_version").notNull(),
    adapterVersion: text("adapter_version").notNull(),

    snapshotId: uuid("snapshot_id"),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    /** Denormalisiert, damit die Look-Ahead-Schranke eine CHECK sein kann. */
    decisionTimestamp: timestamp("decision_timestamp", { withTimezone: true }),

    sourceType: text("source_type", { enum: SOURCE_TYPES }).notNull().default("LIVE"),
    isTestFixture: boolean("is_test_fixture").notNull().default(false),

    /** Fachlicher Schluessel. Derselbe Datenpunkt ergibt denselben Wert. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_obs_dedupe").on(t.dedupeKey),
    index("feature_obs_pit_idx").on(t.tokenId, t.featureName, t.observedAt),
    index("feature_obs_provider_idx").on(t.provider, t.receivedAt),
    index("feature_obs_decision_idx").on(t.decisionId),
    index("feature_obs_snapshot_idx").on(t.snapshotId),
    index("feature_obs_fixture_idx").on(t.isTestFixture, t.receivedAt),

    // Genau eine Wertspalte ist gesetzt.
    check(
      "feature_obs_one_value",
      sql`(value_num is not null)::int + (value_bool is not null)::int + (value_text is not null)::int = 1`,
    ),
    // Nichts kann beobachtet worden sein, nachdem es ankam.
    check("feature_obs_causality", sql`observed_at is null or observed_at <= received_at`),
    /**
     * Kein Look-Ahead — als Constraint, nicht als Filter.
     *
     * Ein vergessener Filter ist ein Bug, eine abgelehnte Zeile ein Zustand.
     */
    check(
      "feature_obs_no_lookahead",
      sql`decision_timestamp is null or observed_at is null or observed_at <= decision_timestamp`,
    ),
    /**
     * Ohne Beobachtungszeitpunkt keine Entscheidung.
     *
     * Die technische Fassung von: ein scheinbar aktueller Wert ohne Zeitstempel
     * sieht spaeter in der Historie genauso aus wie ein verankerter.
     */
    check(
      "feature_obs_safety_needs_timestamp",
      sql`observed_at is not null or decision_safety = 'RESEARCH_ONLY'`,
    ),
    // Ein Fixture traegt nie eine Entscheidung ueber echtes Geld.
    check(
      "feature_obs_fixture_is_research_only",
      sql`not is_test_fixture or decision_safety = 'RESEARCH_ONLY'`,
    ),
    check("feature_obs_fixture_flag", sql`is_test_fixture = (source_type = 'TEST_FIXTURE')`),
    check("feature_obs_quality_range", sql`data_quality between 0 and 1`),
    // Kein geschaetztes Alter, wenn der Zeitpunkt fehlt.
    check("feature_obs_age_needs_timestamp", sql`(observed_at is null) = (data_age_ms is null)`),
  ],
);
