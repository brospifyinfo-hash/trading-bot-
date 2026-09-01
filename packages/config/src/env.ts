import { z } from "zod";

/**
 * Umgebungsvariablen.
 *
 * Fail fast: fehlt oder taugt etwas nicht, startet der Prozess gar nicht erst.
 * Ein Worker, der ohne RPC-URL halb laeuft, ist gefaehrlicher als einer, der
 * sichtbar nicht startet — er trifft Entscheidungen auf luechenhafter Grundlage.
 *
 * Geheimnisse werden hier nur GELESEN, nie geloggt und nie weitergereicht. Der
 * private Schluessel taucht in diesem Schema bewusst nicht auf: er existiert
 * ausschliesslich im Signer-Prozess (siehe apps/signer/src/keystore.ts).
 */

const nonEmpty = z.string().min(1);

export const WORKER_ROLES = [
  "discovery",
  "enrichment",
  "scoring",
  "decision",
  "execution",
  "positions",
  "paper",
  "reconciler",
  "alerts",
  "scheduler",
  // Laeuft auch ohne Marktdaten: der Takt, der eine wiederkehrende Quelle bemerkt.
  "provider-health",
  // Zieht Auftraege aus der dauerhaften Queue und fuehrt sie aus.
  "consumer",
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DATABASE_URL: nonEmpty.url(),
  /**
   * Verbindung fuer Migrationen und andere DDL.
   *
   * Neon (und jeder Pooler im Transaction Mode) trennt zwei Endpunkte: der
   * gepoolte vertraegt kein zuverlaessiges DDL, weil er die Verbindung nach
   * jeder Transaktion weitergibt. Fehlt der Wert, wird DATABASE_URL benutzt —
   * richtig fuer einen einzelnen Postgres ohne Pooler davor.
   *
   * Kein `REDIS_URL` mehr: die dauerhafte Queue liegt in PostgreSQL
   * (Entscheidung 43), und ein Pflichtwert, den niemand liest, kostet auf
   * jeder Plattform einen Eintrag. Siehe Entscheidung 77.
   */
  DATABASE_URL_DIRECT: nonEmpty.url().optional(),
});

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_ROLE: z.enum(WORKER_ROLES),
  SOLANA_RPC_URL: nonEmpty.url(),
  SOLANA_RPC_FALLBACK_URL: nonEmpty.url().optional(),
  /**
   * Interne Adresse des Signer-Dienstes. Nur der execution-Worker nutzt sie, und
   * nur ueber das interne Docker-Netz.
   */
  SIGNER_URL: nonEmpty.url().optional(),
  SIGNER_CLIENT_CERT_PATH: nonEmpty.optional(),
  SIGNER_CLIENT_KEY_PATH: nonEmpty.optional(),
  RESEND_API_KEY: nonEmpty.optional(),
  ALERT_FROM_EMAIL: z.string().email().optional(),
  ALERT_TO_EMAIL: z.string().email().optional(),
});

export const webEnvSchema = baseEnvSchema.extend({
  SESSION_SECRET: nonEmpty.min(32, "SESSION_SECRET muss mindestens 32 Zeichen haben"),
  APP_BASE_URL: nonEmpty.url(),
  RESEND_API_KEY: nonEmpty.optional(),
});

export const signerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  SIGNER_PORT: z.coerce.number().int().min(1).max(65_535).default(8443),
  /** Pfad zum Docker-Secret. Nie der Schluessel selbst in einer Variablen. */
  SIGNER_KEY_FILE: nonEmpty,
  SIGNER_TLS_CERT_PATH: nonEmpty,
  SIGNER_TLS_KEY_PATH: nonEmpty,
  SIGNER_TLS_CLIENT_CA_PATH: nonEmpty,
  /** Harte Obergrenze des SOL-Abflusses pro Transaktion, in Lamports. */
  SIGNER_MAX_SOL_OUT_PER_TX_LAMPORTS: z.coerce.bigint(),
  /** Harte Obergrenze des SOL-Abflusses pro rollierendem Zeitfenster. */
  SIGNER_MAX_SOL_OUT_PER_WINDOW_LAMPORTS: z.coerce.bigint(),
  SIGNER_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3_600),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type SignerEnv = z.infer<typeof signerEnvSchema>;

/**
 * Validiert und beendet den Prozess bei Fehlern.
 *
 * Die Fehlermeldung nennt die betroffenen Variablennamen, aber niemals ihre Werte —
 * sonst landet ein fehlerhaft gesetztes Geheimnis im Log.
 */
export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Ungueltige Umgebungskonfiguration:\n${problems}`);
  }
  return result.data;
}
