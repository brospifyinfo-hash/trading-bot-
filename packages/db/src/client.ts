import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema/index";

/**
 * Datenbankzugriff.
 *
 * Bewusst als Drizzle-Basistyp und nicht an einen Treiber gebunden: Tests fahren
 * denselben Code gegen eine eingebettete Postgres-Instanz (PGlite), der Betrieb
 * gegen den Server. Ein Test, der eine andere Engine benutzt als die Produktion,
 * prueft die falsche Semantik — und gerade beim Point-in-Time-Filter haengt alles
 * an exakter Vergleichs- und Sortiersemantik.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDatabase(
  connectionString: string,
  options: { readonly?: boolean } = {},
): Database {
  const client = postgres(connectionString, {
    max: options.readonly ? 5 : 10,
    prepare: false,
  });
  return drizzlePostgres(client, { schema }) as unknown as Database;
}
