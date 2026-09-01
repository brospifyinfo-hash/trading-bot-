import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Wie weit ein Anbieter fuer EINE Faehigkeit ist.
 *
 * Bewusst je (Anbieter, Capability) und nicht je Anbieter: Birdeye kann fuer
 * `TOKEN_MARKET` bereit sein und fuer `SMART_MONEY` nicht. Ein gemeinsamer
 * Status waere fuer beide falsch.
 */
export const CAPABILITY_STATES = [
  "CONFIGURED",
  /**
   * Etwas zwischen uns und dem Anbieter verweigert (403, 407, 451).
   *
   * Eigener Zustand und ausdruecklich nicht UNAVAILABLE: eine Sperre aendert
   * sich nicht durch Warten, sondern durch eine Freigabe. Wer beides
   * zusammenwirft, wartet auf etwas, das nie von selbst passiert.
   */
  "BLOCKED",
  "CONNECTED",
  "SCHEMA_VERIFIED",
  "CAPABILITY_READY",
  "PRODUCTION_ENABLED",
] as const;

/**
 * Wie gut der Vertrag bekannt ist.
 *
 * Getrennt von der Erkenntnisstufe (woher weiss ich das) — dies beantwortet:
 * wie weit darf der Code damit gehen?
 */
export const IMPLEMENTATION_CONFIDENCES = [
  /** Kein Vertrag. Kein Code. */
  "NONE",
  /** Endpunktname bekannt, Schema nicht. Hoechstens eine Huelle. */
  "SHAPE_ONLY",
  /** Feldnamen und Typen bekannt. Parser und Contract-Tests moeglich. */
  "SCHEMA_KNOWN",
  /** Aus Primaerquelle. Adapter baubar. */
  "SCHEMA_VERIFIED",
] as const;

export const providerCapabilityStatus = pgTable(
  "provider_capability_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id").notNull(),
    capability: text("capability").notNull(),

    state: text("state", { enum: CAPABILITY_STATES }).notNull().default("CONFIGURED"),
    implementationConfidence: text("implementation_confidence", {
      enum: IMPLEMENTATION_CONFIDENCES,
    })
      .notNull()
      .default("NONE"),

    /**
     * Nur ein echter Request setzt das.
     *
     * Die Constraint unten macht es strukturell: ohne einen Smoke-Test mit
     * HTTP-Status und Latenz kann die Spalte gar nicht `true` werden. Ein
     * Fixture hat keinen HTTP-Status — er kommt hier nicht durch.
     */
    productionVerified: boolean("production_verified").notNull().default(false),
    lastSmokeTestAt: timestamp("last_smoke_test_at", { withTimezone: true }),
    lastSmokeTestStatus: integer("last_smoke_test_status"),
    lastSmokeTestDetail: text("last_smoke_test_detail"),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_capability_unique").on(t.providerId, t.capability),
    index("provider_capability_state_idx").on(t.state),
    /**
     * Produktionsreife ohne echten Request ist unmoeglich.
     *
     * Der HTTP-Status ist der Beweis: ein Fixture hat keinen. Damit kann kein
     * Testlauf einen Anbieter als produktionsbereit markieren — nicht weil ein
     * Filter es verhindert, sondern weil die Zeile sonst nicht schreibbar ist.
     */
    check(
      "provider_capability_production_needs_smoke_test",
      sql`not production_verified or (last_smoke_test_at is not null and last_smoke_test_status between 200 and 299)`,
    ),
    // Die Reifekette laesst sich nicht ueberspringen.
    check(
      "provider_capability_ready_needs_schema",
      sql`state not in ('CAPABILITY_READY','PRODUCTION_ENABLED') or implementation_confidence = 'SCHEMA_VERIFIED'`,
    ),
    check(
      "provider_capability_enabled_needs_verification",
      sql`state <> 'PRODUCTION_ENABLED' or production_verified`,
    ),
  ],
);

/**
 * Eine Zeile je echtem Anbieter-Request.
 *
 * Grundlage fuer zwei Fragen, die sich sonst nie beantworten lassen: was kostet
 * eine Gelegenheit an API-Aufrufen, und welcher Anbieter ist tatsaechlich
 * schnell. Beide brauchen Einzelmessungen — ein Mittelwert glaettet genau den
 * Aufruf weg, der zwanzig Sekunden brauchte.
 *
 * Ausdruecklich getrennt von den Handelskosten: eine Position, deren
 * API-Beschaffungskosten in ihre PnL wandern, ist mit keinem Backtest mehr
 * vergleichbar.
 */
export const providerRequests = pgTable(
  "provider_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id").notNull(),
    capability: text("capability").notNull(),
    endpoint: text("endpoint").notNull(),

    at: timestamp("at", { withTimezone: true }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    httpStatus: integer("http_status"),
    success: boolean("success").notNull(),
    failureClass: text("failure_class"),
    failureReason: text("failure_reason"),

    /** Anbietereigene Kosteneinheit (Credits, Compute Units). `null` = unbekannt. */
    costUnits: doublePrecision("cost_units"),
    /** Wie viele Tokens dieser eine Aufruf abgedeckt hat. Bulk > 1. */
    tokensCovered: integer("tokens_covered").notNull().default(1),

    tokenId: uuid("token_id"),
    pipelineStage: text("pipeline_stage"),
    decisionId: uuid("decision_id"),

    /** Ob das Schema der Antwort validiert werden konnte. */
    schemaValid: boolean("schema_valid"),
  },
  (t) => [
    index("provider_requests_provider_idx").on(t.providerId, t.at),
    index("provider_requests_capability_idx").on(t.capability, t.at),
    index("provider_requests_decision_idx").on(t.decisionId),
    check("provider_requests_latency_nonnegative", sql`latency_ms >= 0`),
    check("provider_requests_tokens_positive", sql`tokens_covered >= 1`),
    // Ein Fehlschlag ohne Begruendung ist im Betrieb wertlos.
    check("provider_requests_failure_has_reason", sql`success or failure_class is not null`),
  ],
);
