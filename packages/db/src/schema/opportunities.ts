import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { strategyVersions } from "./strategy";

/**
 * Herkunft eines Datensatzes — die Spalten, die Testdaten von echten trennen.
 *
 * `source_type` und `is_test_fixture` sind bewusst REDUNDANT, und zwar mit
 * einer CHECK-Constraint aneinandergebunden. Der Grund ist praktisch: jede
 * Auswertung filtert auf ein einzelnes boolean, ohne einen Enum-Vergleich
 * korrekt hinschreiben zu muessen — und der CHECK sorgt dafuer, dass die beiden
 * nie auseinanderlaufen koennen.
 */
export const SOURCE_TYPES = ["LIVE", "TEST_FIXTURE", "BACKTEST"] as const;
export const SOURCE_TIERS = ["PRIMARY", "SECONDARY", "FALLBACK"] as const;

export const TRADING_STREAMS = ["AUTO_PAPER", "MANUAL_PAPER", "LIVE"] as const;
export const SIZING_MODES = ["FIXED_100", "RISK_BASED"] as const;
export const OPPORTUNITY_STATES = [
  "OFFERED",
  "SEEN",
  "USER_CONFIRMED",
  "POSITION_OPENED",
  "REJECTED",
  "INVALIDATED",
  "EXPIRED",
  "CANCELLED",
] as const;

/**
 * Eingefrorener Entscheidungszustand.
 *
 * Spec §83 und §115: beim Entry werden alle entscheidungsrelevanten Daten
 * eingefroren. Nachtraegliche Informationen duerfen den historischen Snapshot
 * nicht veraendern.
 *
 * Durchgesetzt wird das NICHT durch einen Kommentar, sondern durch entzogene
 * Schreibrechte in der Migration (`REVOKE UPDATE, DELETE`). Ein Hinweis „bitte
 * nicht aendern" haelt genau so lange, bis jemand unter Zeitdruck ein Feld
 * nachtraegt — und danach passt die Historie zum Ergebnis statt umgekehrt.
 *
 * `features` traegt die Felder aus §113 als JSONB. Bewusst nicht 45 Spalten:
 * der Feature-Satz aendert sich mit jeder Score-Engine-Version, und ein
 * Schemawechsel je Version wuerde die Historie zerreissen. Die Version steht
 * daneben, damit spaeter klar ist, welche Felder erwartbar waren.
 */
export const featureSnapshots = pgTable(
  "feature_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "restrict" }),
    /** Zeitpunkt, fuer den die Features gelten. Der `asOf` des PitReaders. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    features: jsonb("features").notNull(),
    /** Welche Felder fehlten und warum — Teil des Befunds, nicht Rauschen. */
    missingFields: jsonb("missing_fields").notNull().default([]),
    dataCompleteness: doublePrecision("data_completeness").notNull(),
    scoreEngineVersion: text("score_engine_version").notNull(),
    featureSetVersion: text("feature_set_version").notNull(),
    /** Hash ueber den Feature-Vektor. Macht eine Entscheidung exakt reproduzierbar. */
    inputHash: text("input_hash").notNull(),

    /** Herkunft. Siehe SOURCE_TYPES oben. */
    sourceType: text("source_type", { enum: SOURCE_TYPES }).notNull().default("LIVE"),
    /** Anbieterkennung oder Fixture-Etikett. Nie leer. */
    sourceProvider: text("source_provider").notNull().default("unknown"),
    sourceTier: text("source_tier", { enum: SOURCE_TIERS }),
    /** Wann die Quelle geantwortet hat. Differenz zu observed_at = Frische. */
    sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }),
    isTestFixture: boolean("is_test_fixture").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feature_snapshots_pit_idx").on(t.tokenId, t.observedAt),
    index("feature_snapshots_hash_idx").on(t.inputHash),
    // Ein Entscheidungszustand je Token, Beobachtungszeitpunkt und
    // Engine-Version. Zweimal gespeichert waere zweimal dieselbe Wahrheit —
    // und irgendwann laufen die beiden Kopien auseinander.
    uniqueIndex("feature_snapshots_unique").on(t.tokenId, t.observedAt, t.scoreEngineVersion),
    check("feature_snapshots_completeness", sql`data_completeness between 0 and 1`),
    // Die beiden Herkunftsspalten koennen nicht auseinanderlaufen.
    check(
      "feature_snapshots_fixture_flag",
      sql`is_test_fixture = (source_type = 'TEST_FIXTURE')`,
    ),
    // Ein Fixture muss als solches lesbar sein, auch wenn jemand nur diese
    // Spalte sieht.
    check(
      "feature_snapshots_fixture_labelled",
      sql`not is_test_fixture or source_provider like 'TEST_FIXTURE:%'`,
    ),
    // Traegt den zusammengesetzten Fremdschluessel der Gelegenheit.
    uniqueIndex("feature_snapshots_id_fixture").on(t.id, t.isTestFixture),
  ],
);

/**
 * Eine Handelsgelegenheit — eine BEOBACHTUNG, kein Kapital.
 *
 * Hier verlaeuft die Trennung, auf der die gesamte Kategorientrennung ruht.
 * Eine verpasste oder abgelehnte Gelegenheit kann nicht in die Performance
 * geraten, weil sie keine Zeile in `paper_positions` erzeugt — nicht, weil ein
 * Filter sie ausschliesst. Ein vergessener Filter ist ein Bug; eine fehlende
 * Zeile ist ein Zustand.
 *
 * Sie entsteht fuer JEDEN bewerteten Token, nicht nur fuer ENTER (§93): Champion
 * und Challenger muessen dieselben Gelegenheiten sehen. Nebeneffekt — die
 * abgelehnten sind die Kontrollgruppe fuer §41 und §42.
 */
export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "restrict" }),
    stream: text("stream", { enum: TRADING_STREAMS }).notNull(),
    state: text("state", { enum: OPPORTUNITY_STATES }).notNull().default("OFFERED"),

    decisionKind: text("decision_kind", { enum: ["ENTER", "WATCH", "REJECT"] }).notNull(),
    finalScore: smallint("final_score"),
    /** Gruende und Risiken der Entscheidung, wie sie im Alert stehen. */
    reasons: jsonb("reasons").notNull().default([]),
    risks: jsonb("risks").notNull().default([]),
    rejectionReasons: jsonb("rejection_reasons").notNull().default([]),

    featureSnapshotId: uuid("feature_snapshot_id")
      .notNull()
      .references(() => featureSnapshots.id, { onDelete: "restrict" }),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),

    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    /** Nur im Manual-Strom: bis wann eine Reaktion zaehlt (§59). */
    respondBy: timestamp("respond_by", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    /**
     * Herkunft, hier NOCHMALS gefuehrt statt nur am Snapshot.
     *
     * Redundanz mit Absicht: jede Auswertung ueber Gelegenheiten filtert damit
     * ohne Join. Ein vergessener Join waere genau der Weg, auf dem Testdaten in
     * eine Produktionszahl geraten — und ein Join, den man vergessen kann, ist
     * kein Schutz. Der zusammengesetzte Fremdschluessel unten macht ein
     * Auseinanderlaufen unmoeglich.
     */
    sourceType: text("source_type", { enum: SOURCE_TYPES }).notNull().default("LIVE"),
    isTestFixture: boolean("is_test_fixture").notNull().default(false),

    /**
     * Die Entscheidung, aus der diese Gelegenheit stammt.
     *
     * Zwei Gelegenheiten — Auto und Manual — teilen sich denselben Wert. Genau
     * darauf laeuft das System hinaus: haette der Mensch besser entschieden als
     * die Automatik? Ohne gemeinsame Kennung waeren das zwei unabhaengige
     * Beobachtungen, und die Frage nicht mehr stellbar.
     *
     * Nullable, weil Zeilen aus der Zeit vor dieser Tabelle keine tragen.
     */
    decisionId: uuid("decision_id"),
  },
  (t) => [
    // Verhindert doppelte Gelegenheiten aus zwei gleichzeitigen Worker-Laeufen.
    uniqueIndex("opportunities_unique").on(t.tokenId, t.stream, t.decidedAt),
    index("opportunities_decision_idx").on(t.decisionId),
    index("opportunities_state_idx").on(t.state),
    index("opportunities_stream_time_idx").on(t.stream, t.decidedAt),
    // Findet abgelaufene Gelegenheiten fuer den Scheduler (§I-11): der Uebergang
    // nach EXPIRED muss von der Zeit kommen, nicht vom naechsten Login.
    index("opportunities_respond_by_idx").on(t.respondBy).where(sql`state in ('OFFERED','SEEN')`),
    // Ein Antwortfenster, das vor der Entscheidung endet, ist keine
    // Gelegenheit, sondern ein Datenfehler.
    check("opportunities_respond_after_decision", sql`respond_by is null or respond_by > decided_at`),
    check("opportunities_closed_after_decision", sql`closed_at is null or closed_at >= decided_at`),
    check("opportunities_fixture_flag", sql`is_test_fixture = (source_type = 'TEST_FIXTURE')`),
    /**
     * Zusammengesetzter Fremdschluessel auf (Snapshot, Fixture-Flag).
     *
     * Das ist der eigentliche Schutz gegen Vermischung — und er ist
     * deklarativ, nicht geprueft. Eine echte Gelegenheit KANN nicht auf einen
     * Fixture-Snapshot zeigen, weil das Paar (snapshot_id, false) dann in der
     * Zieltabelle nicht existiert. Kein Anwendungscode, keine Reihenfolge, kein
     * vergessener Filter kann daran vorbei.
     */
    foreignKey({
      columns: [t.featureSnapshotId, t.isTestFixture],
      foreignColumns: [featureSnapshots.id, featureSnapshots.isTestFixture],
      name: "opportunities_snapshot_fixture_fk",
    }),
    // Traegt den zusammengesetzten Fremdschluessel der Paper-Position.
    uniqueIndex("opportunities_id_fixture").on(t.id, t.isTestFixture),
    index("opportunities_fixture_idx").on(t.isTestFixture, t.stream),
  ],
);

/**
 * Was mit dem Token NACH der Gelegenheit passiert ist.
 *
 * Das Entscheidende an dieser Tabelle ist, was sie NICHT hat: keine
 * Positionsgroesse, keine Waehrung, kein realisiertes Ergebnis. Nur
 * hypothetische Renditen als Anteil.
 *
 * Damit ist es strukturell unmoeglich, sie in eine Performance-Abfrage zu
 * ziehen — es gibt keine Spalte, die sich mit einem realisierten Ergebnis
 * verrechnen liesse. Genau das erfuellt §42, §66 und §78, ohne sich auf
 * Disziplin bei der Abfrage zu verlassen.
 */
export const opportunityOutcomes = pgTable(
  "opportunity_outcomes",
  {
    opportunityId: uuid("opportunity_id")
      .primaryKey()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    referencePriceUsd: doublePrecision("reference_price_usd").notNull(),
    return5m: doublePrecision("return_5m"),
    return15m: doublePrecision("return_15m"),
    return30m: doublePrecision("return_30m"),
    return1h: doublePrecision("return_1h"),
    return4h: doublePrecision("return_4h"),
    /** Hoechster und tiefster Punkt nach der Entscheidung, als Anteil. */
    hypotheticalMfe: doublePrecision("hypothetical_mfe"),
    hypotheticalMae: doublePrecision("hypothetical_mae"),
    observedUntil: timestamp("observed_until", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Nutzerreaktionen auf eine Manual-Gelegenheit.
 *
 * Append-only, mehrere Zeilen je Gelegenheit moeglich (erst SEEN, dann
 * USER_CONFIRMED). `responseMs` wird JE ZEILE gefuehrt, nicht als Mittelwert:
 * §80 verlangt realistische menschliche Latenz, und ein Median glaettet genau
 * die Faelle weg, in denen die Verzoegerung wehtat.
 */
export const manualResponses = pgTable(
  "manual_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["SEEN", "USER_CONFIRMED", "REJECTED"] }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** Zeit zwischen Alert-Versand und dieser Reaktion. */
    responseMs: integer("response_ms").notNull(),
    /** Preis zum Reaktionszeitpunkt — Grundlage der Revalidierung (§67). */
    priceAtResponseUsd: doublePrecision("price_at_response_usd"),
  },
  (t) => [index("manual_responses_opportunity_idx").on(t.opportunityId, t.at)],
);

/**
 * Simulierte Position.
 *
 * Getrennte Tabelle von den Live-Positionen — nicht eine Spalte, sondern zwei
 * Tabellen. `PAPER ≠ LIVE` wird damit nicht von einem `WHERE mode = 'paper'`
 * getragen, sondern vom Schema.
 *
 * `sizingMode` ist Pflicht. Ein fixer 100-Euro-Trade und eine nach Stop-Abstand
 * skalierte Groesse erzeugen VERSCHIEDENE Renditeverteilungen — andere Varianz,
 * anderer Drawdown, anderes Ruin-Risiko. Gemischt ist jede Kennzahl
 * bedeutungslos (§61 gegen §29, aufgeloest in §84).
 */
export const paperPositions = pgTable(
  "paper_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Jede Paper-Position stammt aus genau einer Gelegenheit — und eine
     * Gelegenheit erzeugt hoechstens eine Position.
     */
    opportunityId: uuid("opportunity_id")
      .notNull()
      .unique()
      .references(() => opportunities.id, { onDelete: "restrict" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "restrict" }),
    stream: text("stream", { enum: TRADING_STREAMS }).notNull(),
    sizingMode: text("sizing_mode", { enum: SIZING_MODES }).notNull(),

    entryNotionalMinor: bigint("entry_notional_minor", { mode: "bigint" }).notNull(),
    currency: text("currency", { enum: ["EUR", "USD"] }).notNull(),
    entryAmountRaw: bigint("entry_amount_raw", { mode: "bigint" }).notNull(),
    remainingAmountRaw: bigint("remaining_amount_raw", { mode: "bigint" }).notNull(),

    realizedPnlMinor: bigint("realized_pnl_minor", { mode: "bigint" }).notNull().default(sql`0`),
    costsPaidMinor: bigint("costs_paid_minor", { mode: "bigint" }).notNull().default(sql`0`),

    /** Maximum Adverse / Favorable Excursion (§36, §37), als Anteil. */
    maxAdverseExcursion: doublePrecision("max_adverse_excursion"),
    maxFavorableExcursion: doublePrecision("max_favorable_excursion"),
    /** Realisiert geteilt durch erreichbares MFE (§38). */
    exitEfficiency: doublePrecision("exit_efficiency"),

    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    exitReason: text("exit_reason"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    /**
     * Optimistische Sperre.
     *
     * Zwei Worker, die dieselbe Position gleichzeitig anfassen, duerfen sich
     * nicht gegenseitig ueberschreiben — sonst geht ein Teilverkauf verloren
     * und der Restbestand stimmt nicht mehr mit der Chain ueberein. Jede
     * Aenderung erhoeht diesen Zaehler und verlangt den erwarteten Wert im
     * WHERE.
     */
    version: integer("version").notNull().default(0),

    /** Herkunft, gespiegelt von der Gelegenheit. Siehe dort. */
    sourceType: text("source_type", { enum: SOURCE_TYPES }).notNull().default("LIVE"),
    isTestFixture: boolean("is_test_fixture").notNull().default(false),
  },
  (t) => [
    index("paper_positions_stream_idx").on(t.stream, t.sizingMode, t.openedAt),
    index("paper_positions_fixture_idx").on(t.isTestFixture, t.stream),
    index("paper_positions_open_idx").on(t.closedAt),
    // Zustandskonsistenz in der Datenbank, nicht im Anwendungscode: ein
    // Restbestand ausserhalb von [0, Einstieg] ist ein Buchungsfehler, und
    // eine geschlossene Position ohne Grund ist nicht auswertbar.
    check("paper_positions_remaining_range", sql`remaining_amount_raw >= 0 and remaining_amount_raw <= entry_amount_raw`),
    check("paper_positions_notional_positive", sql`entry_notional_minor > 0`),
    check("paper_positions_closed_order", sql`closed_at is null or closed_at >= opened_at`),
    check("paper_positions_closed_has_reason", sql`closed_at is null or exit_reason is not null`),
    check("paper_positions_fixture_flag", sql`is_test_fixture = (source_type = 'TEST_FIXTURE')`),
    // Dieselbe Kette eine Stufe weiter: eine Position erbt das Flag ihrer
    // Gelegenheit, und die Datenbank laesst nichts anderes zu.
    foreignKey({
      columns: [t.opportunityId, t.isTestFixture],
      foreignColumns: [opportunities.id, opportunities.isTestFixture],
      name: "paper_positions_opportunity_fixture_fk",
    }),
  ],
);

export const paperPositionEvents = pgTable(
  "paper_position_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => paperPositions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("paper_position_events_pos_idx").on(t.positionId, t.at)],
);
