import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const MARKET_REGIMES = ["RISK_ON", "NEUTRAL", "RISK_OFF", "UNKNOWN"] as const;

/**
 * Verlauf der Marktregime.
 *
 * Append-only, und das ist der ganze Zweck der Tabelle. Ein rueckwirkend
 * vergebenes Regime-Label ist Look-Ahead, der wie eine Erkenntnis aussieht
 * (I-3): wer im Nachhinein sagt „das war eine Risk-Off-Phase" und die Trades
 * dieser Phase anschliessend auswertet, hat den Ausgang benutzt, um die
 * Bedingung zu definieren.
 *
 * Durchgesetzt an drei Stellen, weil eine nicht reicht:
 *
 * - `RegimeTimeline` weist einen Eintrag vor dem letzten ab (Laufzeit)
 * - `UNIQUE (observed_at)` verhindert zwei Labels fuer denselben Moment (Schema)
 * - `REVOKE UPDATE, DELETE` in der Migration (Datenbank)
 *
 * `votes` haelt die Einzelstimmen fest. Ohne sie liesse sich spaeter nicht mehr
 * sagen, ob ein Regimewechsel auf breiter Grundlage stand oder an einem
 * einzelnen Indikator hing.
 */
export const marketRegimes = pgTable(
  "market_regimes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regime: text("regime", { enum: MARKET_REGIMES }).notNull(),
    /** Zeitpunkt der Messung. Nicht der Zeitpunkt des Schreibens. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** Stimme je Indikator zum Beobachtungszeitpunkt. */
    votes: jsonb("votes").notNull(),
    /** Indikatoren ohne Daten — nicht dasselbe wie neutral gestimmt. */
    missingIndicators: jsonb("missing_indicators").notNull().default([]),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("market_regimes_observed_at").on(t.observedAt),
    index("market_regimes_regime_idx").on(t.regime, t.observedAt),
  ],
);
