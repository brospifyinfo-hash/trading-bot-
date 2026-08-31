import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { opportunities } from "./opportunities";

/**
 * Zeitstempelkette je Vorgang.
 *
 * §106 verlangt die Kette, I-9 verlangt sie EINZELN. Deshalb eine Zeile je
 * Gelegenheit und keine aggregierten Spalten: sobald irgendwo ein
 * `avg_response_ms` steht, wird irgendwann damit simuliert — und ein Median
 * glaettet genau die Faelle weg, in denen die Verzoegerung wehtat.
 *
 * Die Stufen stehen als eigene Spalten und nicht als JSONB, weil ueber sie
 * ausgewertet wird (Perzentile je Abschnitt). Fehlende Stufen sind NULL:
 * ein Auto-Trade hat keinen Alert, und das ist kein Datenverlust.
 */
export const latencySamples = pgTable(
  "latency_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    /** Strom, damit Auto und Manual nie in derselben Verteilung landen. */
    stream: text("stream").notNull(),

    observedAt: timestamp("observed_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Eine Kette je Gelegenheit. Zwei waeren zwei Antworten auf dieselbe Frage,
    // und die Auswertung wuesste nicht, welche gilt.
    uniqueIndex("latency_samples_opportunity").on(t.opportunityId),
    index("latency_samples_stream_idx").on(t.stream, t.decidedAt),
  ],
);
