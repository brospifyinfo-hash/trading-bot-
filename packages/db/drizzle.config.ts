import { defineConfig } from "drizzle-kit";

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
const url = process.env["DATABASE_URL_DIRECT"] ?? process.env["DATABASE_URL"];

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
