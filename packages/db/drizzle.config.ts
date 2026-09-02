import { defineConfig } from "drizzle-kit";

import { sanitizeConnectionString } from "./src/connection-string";

/**
 * Migrationen laufen ueber die DIREKTE Verbindung, nicht ueber den Pooler.
 *
 * Neon, Supabase und PgBouncer im Transaction Mode geben die Verbindung nach
 * jeder Transaktion weiter. DDL ueber so eine Verbindung ist nicht zuverlaessig:
 * `CREATE INDEX CONCURRENTLY` scheitert, Advisory Locks halten nicht, und eine
 * lange Migration kann mitten im Lauf auf einer anderen Verbindung landen.
 *
 * Deshalb `DATABASE_URL_DIRECT` zuerst. Fehlt er, gilt `DATABASE_URL` — richtig
 * fuer einen einzelnen Postgres ohne Pooler davor, etwa lokal.
 */
const raw = process.env["DATABASE_URL_DIRECT"] ?? process.env["DATABASE_URL"];

/**
 * Dieselbe Bereinigung wie zur Laufzeit — und zwar aus einem echten Fehlschlag
 * heraus.
 *
 * `drizzle-kit` laeuft NICHT durch `createDatabase()`, sondern baut sich seine
 * Verbindung selbst aus dieser Konfiguration. Die Bereinigung dort half hier
 * also nichts: mit einer Neon-Zeichenfolge brach schon der Migrationslauf ab
 * mit `unrecognized configuration parameter "channel_binding"`.
 *
 * Zwei Wege zur Datenbank heissen zwei Stellen, an denen dieselbe Bereinigung
 * gebraucht wird. Deshalb liegt sie in einem eigenen Modul ohne
 * Abhaengigkeiten, das beide importieren.
 */
const url = raw === undefined ? undefined : sanitizeConnectionString(raw);

if (url === undefined || url.length === 0) {
  throw new Error(
    "Weder DATABASE_URL_DIRECT noch DATABASE_URL gesetzt. " +
      "Migrationen brauchen die direkte Verbindung (bei Neon: der Endpunkt OHNE '-pooler').",
  );
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  // Vorwaerts-only: Migrationen werden nie rueckwaerts gefahren. Ein Rollback in
  // einer Datenbank, die Handelshistorie fuehrt, verliert Forschungsdaten.
  strict: true,
});
