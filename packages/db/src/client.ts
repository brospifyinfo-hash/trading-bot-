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

/**
 * Verbindungsparameter, die `postgres-js` an den Server durchreicht, obwohl
 * PostgreSQL sie nicht kennt.
 *
 * Der Hintergrund ist ein echter Ausfall, kein theoretisches Risiko.
 * `postgres-js` sammelt alle Query-Parameter der URL ein, behandelt die ihm
 * bekannten (`sslmode` wird zu `ssl`) und legt **alle uebrigen** in
 * `connection` — von dort gehen sie als Startup-Parameter an den Server. Fuer
 * eine libpq-Client-Option wie `channel_binding` antwortet PostgreSQL dann:
 *
 *     unrecognized configuration parameter "channel_binding"
 *
 * Die Verbindung kommt gar nicht erst zustande. Neon haengt genau diesen
 * Parameter standardmaessig an seine Verbindungszeichenfolgen, und die
 * Neon-Vercel-Integration traegt sie unveraendert ein — der Fehler kommt also
 * bei jeder Neuprovisionierung zurueck, wenn man ihn nur in der Plattform
 * wegloescht.
 *
 * Alle hier gelisteten Namen sind libpq-**Client**-Optionen: sie steuern, wie
 * der Client sich verbindet, und haben serverseitig keine Bedeutung. Sie zu
 * entfernen aendert nichts an der Sicherheit der Verbindung — `sslmode` bleibt
 * unangetastet und wird von `postgres-js` korrekt in TLS uebersetzt.
 */
const LIBPQ_CLIENT_ONLY_PARAMS: readonly string[] = [
  "channel_binding",
  "gssencmode",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslcompression",
  "krbsrvname",
  "passfile",
  "service",
];

/**
 * Entfernt Parameter, die sonst als unbekannte Startup-Parameter beim Server
 * landen.
 *
 * Faellt bei einer unparsbaren Zeichenfolge auf das Original zurueck: eine
 * kaputte URL soll den bestehenden Fehler zeigen und nicht einen neuen aus
 * dieser Funktion.
 */
export function sanitizeConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  let changed = false;
  for (const name of LIBPQ_CLIENT_ONLY_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return connectionString;

  // `toString()` normalisiert sonst auch das Passwort (Prozentkodierung), was
  // eine funktionierende Verbindung zerstoeren koennte. Deshalb nur den
  // Query-Teil ersetzen und den Rest der Zeichenfolge unangetastet lassen.
  const query = url.searchParams.toString();
  const [head] = connectionString.split("?", 1);
  return query.length > 0 ? `${head}?${query}` : (head ?? connectionString);
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
