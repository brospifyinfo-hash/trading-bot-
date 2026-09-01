/**
 * Infrastruktur-Smoke-Test: laeuft die Datenbank, und stimmt ihr Zustand?
 *
 * Beantwortet nach einem Deployment die Fragen, die man sonst von Hand mit
 * `psql` zusammensucht:
 *
 *   Verbindung? · Migrationen vollstaendig? · Tabellen da? · Constraints scharf?
 *   · Schreibt der Produktionscode tatsaechlich? · Ist die Queue benutzbar?
 *
 * **Standardmaessig nur lesend.** Das ist Absicht: dieses Skript zeigt auf eine
 * echte Datenbank, und ein Diagnosewerkzeug, das ungefragt schreibt, ist ein
 * Risiko und kein Werkzeug. Der Schreibtest laeuft nur mit `--write` und legt
 * ausschliesslich als `is_test_fixture` markierte Zeilen an, die er danach
 * wieder entfernt.
 *
 * Ausfuehren:
 *   DATABASE_URL=... pnpm --filter @sae/worker exec tsx src/smoke/infrastructure.ts
 *   DATABASE_URL=... pnpm --filter @sae/worker exec tsx src/smoke/infrastructure.ts --write
 *
 * Exit-Codes: 0 alles gruen · 1 ein Check fehlgeschlagen · 2 Aufruffehler
 */

/* eslint-disable no-console -- Kommandozeilenwerkzeug: die Ausgabe ist das Ergebnis. */
import { createDatabase, type Database } from "@sae/db";
import { sql } from "drizzle-orm";

export type CheckOutcome = "PASS" | "FAIL" | "WARN" | "SKIPPED";

export interface CheckResult {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

/**
 * Die Tabellen, ohne die kein Takt laufen kann.
 *
 * Bewusst nicht alle 61: diese Liste ist die Startbedingung, nicht das
 * vollstaendige Schema. Sie wird gegen die Datenbank geprueft, nicht gegen
 * eine Annahme.
 */
const REQUIRED_TABLES: readonly string[] = [
  "tokens",
  "token_snapshots",
  "job_queue",
  "job_queue_history",
  "provider_status_samples",
  "provider_capability_status",
  "provider_requests",
  "opportunities",
  "paper_positions",
  "decisions",
  "feature_observations",
];

/**
 * Constraints, die eine Sicherheitsaussage tragen.
 *
 * Fehlt einer davon, ist eine Zusicherung dieses Systems nur noch eine
 * Behauptung im Anwendungscode — und die laesst sich mit einem `psql`-Einzeiler
 * umgehen.
 */
const REQUIRED_CONSTRAINTS: readonly { readonly table: string; readonly name: string; readonly why: string }[] = [
  {
    table: "provider_capability_status",
    name: "provider_capability_production_needs_smoke_test",
    why: "PRODUCTION_VERIFIED ohne echten 2xx-Smoke-Test",
  },
  {
    table: "provider_capability_status",
    name: "provider_capability_enabled_needs_verification",
    why: "PRODUCTION_ENABLED ohne Verifikation",
  },
  {
    table: "feature_observations",
    name: "feature_obs_no_lookahead",
    why: "Beobachtung nach der Entscheidung (Look-Ahead)",
  },
  {
    table: "feature_observations",
    name: "feature_obs_safety_needs_timestamp",
    why: "DECISION_SAFE ohne Beobachtungszeitpunkt",
  },
  {
    table: "feature_observations",
    name: "feature_obs_fixture_is_research_only",
    why: "Test-Fixture als entscheidungstauglich",
  },
  {
    table: "paper_positions",
    name: "paper_positions_opportunity_id_unique",
    why: "zwei Paper-Positionen auf dieselbe Gelegenheit",
  },
  {
    table: "paper_positions",
    name: "paper_positions_notional_positive",
    why: "Paper-Position mit Einsatz <= 0",
  },
];

const EXPECTED_MIGRATIONS = 10;

export async function runInfrastructureChecks(input: {
  readonly db: Database;
  readonly allowWrite: boolean;
}): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (name: string, outcome: CheckOutcome, detail: string): void => {
    results.push({ name, outcome, detail });
  };

  /* ---------------------------------------------------- 1. Verbindung */
  try {
    const rows = await input.db.execute<{ v: string }>(
      sql`select version() as v`,
    );
    const version = versionOf(rows);
    push("1. VERBINDUNG", "PASS", version ?? "verbunden, Version unbekannt");
  } catch {
    // Der Fehler wird bewusst nicht ausgegeben: eine Postgres-Fehlermeldung
    // enthaelt die Verbindungszeichenfolge samt Passwort.
    push("1. VERBINDUNG", "FAIL", "Keine Verbindung. DATABASE_URL pruefen (Wert wird hier nie ausgegeben).");
    return results;
  }

  /* ---------------------------------------------------- 2. Migrationen */
  try {
    const rows = await input.db.execute<{ n: number }>(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    const applied = countOf(rows, "n");
    push(
      "2. MIGRATIONEN",
      applied === null
        ? "FAIL"
        : applied === EXPECTED_MIGRATIONS
          ? "PASS"
          : applied < EXPECTED_MIGRATIONS
            ? "FAIL"
            : "WARN",
      applied === null
        ? "Zaehlung des drizzle-Journals lieferte keine Zeile."
        : applied === EXPECTED_MIGRATIONS
          ? `${String(applied)} angewendet.`
          : applied < EXPECTED_MIGRATIONS
            ? `Nur ${String(applied)} von ${String(EXPECTED_MIGRATIONS)}. Migration ausfuehren: pnpm --filter @sae/db exec drizzle-kit migrate`
            : `${String(applied)} statt ${String(EXPECTED_MIGRATIONS)} — die Datenbank ist neuer als dieser Code.`,
    );
    if (applied === null || applied < EXPECTED_MIGRATIONS) return results;
  } catch {
    push("2. MIGRATIONEN", "FAIL", "Kein drizzle-Journal. Die Datenbank ist leer oder nie migriert worden.");
    return results;
  }

  /* ---------------------------------------------------- 3. Tabellen */
  const tableRows = await input.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  );
  const tables = new Set(collect(tableRows, "table_name"));
  const missingTables = REQUIRED_TABLES.filter((t) => !tables.has(t));
  push(
    "3. TABELLEN",
    missingTables.length === 0 ? "PASS" : "FAIL",
    missingTables.length === 0
      ? `${String(tables.size)} Tabellen, alle ${String(REQUIRED_TABLES.length)} benoetigten vorhanden.`
      : `Fehlt: ${missingTables.join(", ")}`,
  );

  /* ---------------------------------------------------- 4. Constraints */
  const constraintRows = await input.db.execute<{ conname: string }>(
    sql`select c.conname from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'`,
  );
  const constraints = new Set(collect(constraintRows, "conname"));
  const missingConstraints = REQUIRED_CONSTRAINTS.filter((c) => !constraints.has(c.name));
  push(
    "4. SICHERHEITS-CONSTRAINTS",
    missingConstraints.length === 0 ? "PASS" : "FAIL",
    missingConstraints.length === 0
      ? `Alle ${String(REQUIRED_CONSTRAINTS.length)} scharf.`
      : `Fehlt — damit waere moeglich: ${missingConstraints.map((c) => c.why).join("; ")}`,
  );

  /* ---------------------------------------------------- 5. Constraint beisst */
  // Ein Constraint, das in der Katalogtabelle steht, aber nicht ausloest, waere
  // die gefaehrlichste Variante: sie sieht in jeder Pruefung richtig aus.
  if (constraints.has("provider_capability_production_needs_smoke_test")) {
    let rejected = false;
    try {
      await input.db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into provider_capability_status
            (provider_id, capability, state, implementation_confidence, production_verified)
          values ('__smoke_probe__', 'TOKEN_MARKET', 'CONNECTED', 'SCHEMA_KNOWN', true)
        `);
        // Nie erreicht, wenn das Constraint greift. Sicherheitshalber zurueck.
        throw new RollbackProbe();
      });
    } catch (error: unknown) {
      rejected = !(error instanceof RollbackProbe);
    }
    push(
      "5. CONSTRAINT GREIFT",
      rejected ? "PASS" : "FAIL",
      rejected
        ? "PRODUCTION_VERIFIED ohne 2xx-Smoke-Test wird von der Datenbank abgelehnt."
        : "Die Datenbank liess einen unverifizierten Anbieter als verifiziert durch.",
    );
  } else {
    push("5. CONSTRAINT GREIFT", "SKIPPED", "Constraint nicht vorhanden, siehe Check 4.");
  }

  /* ---------------------------------------------------- 6. Queue lesbar */
  try {
    const rows = await input.db.execute<{ n: number }>(
      sql`select count(*)::int as n from job_queue where state in ('QUEUED','RUNNING')`,
    );
    const open = countOf(rows, "n");
    const dead = await input.db.execute<{ n: number }>(
      sql`select count(*)::int as n from job_queue where state = 'DEAD'`,
    );
    const deadCount = countOf(dead, "n");
    push(
      "6. QUEUE",
      open === null || deadCount === null ? "FAIL" : deadCount === 0 ? "PASS" : "WARN",
      open === null || deadCount === null
        ? "Zaehlung lieferte keine Zeile."
        : `${String(open)} offen, ${String(deadCount)} im Dead Letter.` +
          (deadCount > 0 ? " Dead Letter ansehen: sie verschwinden nicht von selbst." : ""),
    );
  } catch {
    push("6. QUEUE", "FAIL", "job_queue nicht lesbar.");
  }

  /* ---------------------------------------------------- 7. Anbieterlage */
  try {
    const rows = await input.db.execute<{ n: number }>(
      sql`select count(*)::int as n from provider_capability_status where production_verified`,
    );
    const verified = countOf(rows, "n");
    push(
      "7. ANBIETER",
      verified === null ? "FAIL" : verified > 0 ? "PASS" : "WARN",
      verified === null
        ? "Zaehlung lieferte keine Zeile."
        : verified > 0
        ? `${String(verified)} Faehigkeit(en) produktiv verifiziert.`
        : "Kein Anbieter produktiv verifiziert. Das System sammelt keine Marktdaten — erwartet, solange der Egress fehlt.",
    );
  } catch {
    push("7. ANBIETER", "FAIL", "provider_capability_status nicht lesbar.");
  }

  /* ---------------------------------------------------- 8. Schreibpfad */
  if (!input.allowWrite) {
    push(
      "8. SCHREIBPFAD",
      "SKIPPED",
      "Nur lesend gelaufen. Mit --write ausfuehren, um einen echten Schreibvorgang zu pruefen.",
    );
    return results;
  }

  let readBack: number | null = null;
  try {
    await input.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into provider_requests
          (provider_id, capability, endpoint, at, latency_ms, http_status, success, pipeline_stage)
        values ('__smoke_probe__', 'TOKEN_MARKET', '/__smoke__', now(), 1, 200, true, 'SMOKE_TEST')
      `);
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from provider_requests where provider_id = '__smoke_probe__'`,
      );
      readBack = countOf(rows, "n");
      // Immer zurueckrollen: der Beweis ist der erfolgreiche Schreib- und
      // Lesevorgang, nicht die zurueckbleibende Zeile.
      throw new RollbackProbe();
    });
    push("8. SCHREIBPFAD", "FAIL", "Transaktion wurde nicht zurueckgerollt.");
  } catch (error: unknown) {
    push(
      "8. SCHREIBPFAD",
      error instanceof RollbackProbe && readBack === 1 ? "PASS" : "FAIL",
      error instanceof RollbackProbe
        ? `Schreiben, Zuruecklesen (${String(readBack)} Zeile) und Rollback erfolgreich. Nichts zurueckgeblieben.`
        : "Schreiben fehlgeschlagen. Rechte des Datenbankbenutzers pruefen.",
    );
  }

  return results;
}

/** Bricht eine Sondierungstransaktion ab, ohne einen Fehler vorzutaeuschen. */
class RollbackProbe extends Error {
  constructor() {
    super("rollback probe");
    this.name = "RollbackProbe";
  }
}

/* Treiberunterschiede: postgres-js liefert ein Array, PGlite ein { rows }. */
function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as readonly Record<string, unknown>[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as readonly Record<string, unknown>[];
  }
  return [];
}

function firstValue(result: unknown, key: string): unknown {
  return rowsOf(result)[0]?.[key];
}

/**
 * Der Zaehlwert einer `count(*)`-Abfrage, oder `null`.
 *
 * Ausdruecklich kein `?? 0`: eine Zaehlabfrage liefert immer eine Zeile. Kommt
 * keine, ist die Abfrage fehlgeschlagen — und das als "0" zu melden waere
 * genau die Sorte Beschoenigung, die dieses Werkzeug verhindern soll.
 */
function countOf(result: unknown, key: string): number | null {
  const raw = firstValue(result, key);
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function collect(result: unknown, key: string): readonly string[] {
  return rowsOf(result)
    .map((r) => r[key])
    .filter((v): v is string => typeof v === "string");
}

function versionOf(result: unknown): string | null {
  const v = firstValue(result, "v");
  return typeof v === "string" ? v.split(",")[0] ?? v : null;
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  const allowWrite = process.argv.includes("--write");

  if (url === undefined || url.length === 0) {
    console.error("DATABASE_URL fehlt.");
    process.exit(2);
  }

  const db = createDatabase(url, { maxConnections: 2 });
  const results = await runInfrastructureChecks({ db, allowWrite });

  console.log("\nINFRASTRUKTUR-SMOKE-TEST" + (allowWrite ? "  (mit Schreibtest)" : "  (nur lesend)") + "\n");
  for (const r of results) {
    console.log(`  [${r.outcome.padEnd(7)}] ${r.name}`);
    console.log(`            ${r.detail}`);
  }

  const failed = results.filter((r) => r.outcome === "FAIL");
  console.log(
    `\nGesamt: ${failed.length === 0 ? "OK" : `${String(failed.length)} Check(s) fehlgeschlagen`}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("infrastructure.ts") === true) {
  void main();
}
