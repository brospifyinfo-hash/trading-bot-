import { getDatabase, SERVERLESS_DB_OPTIONS, type Database } from "@sae/db";
import { loadEnv, webEnvSchema } from "@sae/config";

/**
 * Datenbankzugriff der Web-App.
 *
 * EINE Stelle, an der die Verbindung entsteht — und sie liegt auf Modulebene,
 * nicht im Request-Handler. Der Unterschied ist auf einer Serverless-Plattform
 * nicht theoretisch: eine Instanz bedient viele Anfragen, und ein Pool je
 * Anfrage waere ein Pool je Anfrage.
 *
 * `SERVERLESS_DB_OPTIONS` haelt den Pool auf einer Verbindung. Das klingt wenig
 * und ist es auch — genau richtig, wenn beliebig viele Instanzen parallel
 * laufen koennen. Die Skalierung uebernimmt der Pooler vor der Datenbank, nicht
 * dieser Prozess.
 */

export function db(): Database {
  const env = loadEnv(webEnvSchema, process.env);
  return getDatabase(env.DATABASE_URL, { ...SERVERLESS_DB_OPTIONS, readonly: true });
}

/** Schreibender Zugriff — nur der Bestaetigungs-Flow braucht ihn. */
export function writableDb(): Database {
  const env = loadEnv(webEnvSchema, process.env);
  return getDatabase(env.DATABASE_URL, { ...SERVERLESS_DB_OPTIONS, readonly: false });
}
