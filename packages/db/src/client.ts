import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema/index";
import { sanitizeConnectionString } from "./connection-string";

// Weiterhin von hier exportiert: bestehende Importe bleiben gueltig.
export { sanitizeConnectionString } from "./connection-string";

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

export interface DatabaseOptions {
  readonly readonly?: boolean;
  /**
   * Wie viele Verbindungen dieser Prozess halten darf.
   *
   * Auf einer Serverless-Plattform gehoert hier eine kleine Zahl hin: jede
   * Instanz baut einen eigenen Pool auf, und hundert Instanzen mit je zehn
   * Verbindungen sind tausend Verbindungen gegen eine Datenbank, die einige
   * Dutzend vertraegt. Der Worker darf mehr, weil es von ihm wenige gibt.
   */
  readonly maxConnections?: number;
  /** Verbindungen ohne Arbeit werden nach dieser Zeit geschlossen. */
  readonly idleTimeoutSeconds?: number;
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Database {
  const client = postgres(sanitizeConnectionString(connectionString), {
    // Betriebsparameter, kein Handelsinput: eine Poolgroesse beeinflusst keine
    // Entscheidung.
    max: options.maxConnections ?? (options.readonly ? 5 : 10),
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    // Prepared Statements vertragen sich nicht mit einem Pooler im
    // Transaction Mode (PgBouncer, Neon pooled): der Pooler gibt die
    // Verbindung nach jeder Transaktion weiter, und das vorbereitete
    // Statement ist dann auf einer anderen.
    prepare: false,
  });
  return drizzlePostgres(client, { schema }) as unknown as Database;
}

/**
 * Eine Verbindung je Prozess, nicht je Anfrage.
 *
 * Der Fehler, den das behebt: `createDatabase()` im Request-Handler legt bei
 * JEDER Anfrage einen neuen Pool an. Auf einer Serverless-Plattform, wo eine
 * Instanz viele Anfragen bedient und viele Instanzen parallel laufen, ist das
 * der direkte Weg in „too many connections" — und zwar unter Last, also genau
 * dann, wenn man hinsieht.
 *
 * Der Cache haengt am Modulobjekt. Auf Vercel ueberlebt er den Warm Start und
 * wird beim Cold Start neu aufgebaut; mehr Lebensdauer gibt es dort nicht, und
 * mehr braucht es auch nicht.
 *
 * Der Schluessel enthaelt die Optionen: eine lesende und eine schreibende
 * Verbindung sind zwei verschiedene Pools und duerfen sich nicht gegenseitig
 * ueberschreiben.
 */
const cache = new Map<string, Database>();

export function getDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  // Der Schluessel enthaelt die Verbindungszeichenfolge — und die enthaelt das
  // Passwort. Er bleibt deshalb im Prozessspeicher und wird nirgends
  // ausgegeben: nicht geloggt, nicht in einer Fehlermeldung, nicht im
  // Dashboard.
  const key = JSON.stringify([
    connectionString,
    options.readonly ?? false,
    options.maxConnections ?? null,
    options.idleTimeoutSeconds ?? null,
  ]);

  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const created = createDatabase(connectionString, options);
  cache.set(key, created);
  return created;
}

/** Nur fuer Tests: leert den Verbindungscache. */
export function resetDatabaseCache(): void {
  cache.clear();
}

/**
 * Voreinstellung fuer anfragegetriebene Umgebungen.
 *
 * Klein und kurzlebig. Wer diese Werte erhoeht, sollte vorher wissen, wie viele
 * Instanzen gleichzeitig laufen koennen.
 */
export const SERVERLESS_DB_OPTIONS: DatabaseOptions = {
  maxConnections: 1,
  idleTimeoutSeconds: 10,
};
