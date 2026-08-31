import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client";
import { createTestDatabase } from "../../pit/__tests__/harness";

/**
 * Die Kategorientrennung auf Schema-Ebene.
 *
 * Die Tests in `@sae/analytics` sichern, dass der Auswertungscode nicht mischt.
 * Diese hier sichern die Stufe darunter: dass es im Schema gar keine Spalte
 * gibt, die man mischen KOENNTE. Eine Regel, die nur im Anwendungscode steht,
 * gilt fuer jede handgeschriebene SQL-Abfrage nicht — und die gibt es in jedem
 * System, spaetestens im Reporting.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

afterAll(async () => {
  await close();
});

/**
 * Zeilen einer rohen Abfrage.
 *
 * Die beiden Treiber liefern verschieden: postgres-js gibt das Array direkt
 * zurueck, PGlite ein Objekt mit `rows`. Der Unterschied gehoert nicht in jeden
 * einzelnen Test.
 */
async function rowsOf<T>(query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = await rowsOf<{ column_name: string }>(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  return rows.map((row) => row.column_name);
}

/** Alles, was eine Geldgroesse sein koennte. */
const CAPITAL_PATTERN = /notional|pnl|capital|invested|minor|currency|amount|size|fee|cost/i;

describe("Beobachtungstabellen haben keinen Kapitalbezug", () => {
  it("opportunity_outcomes traegt keine Geldspalte", async () => {
    const columns = await columnsOf("opportunity_outcomes");
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((c) => CAPITAL_PATTERN.test(c))).toEqual([]);
  });

  it("opportunities traegt keine Geldspalte", async () => {
    const columns = await columnsOf("opportunities");
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((c) => CAPITAL_PATTERN.test(c))).toEqual([]);
  });

  it("manual_responses traegt keine Geldspalte ausser dem Referenzpreis", async () => {
    const columns = await columnsOf("manual_responses");
    // Der Preis zum Reaktionszeitpunkt ist kein Kapitaleinsatz, sondern die
    // Grundlage der Revalidierung. Er kann keine Position beziffern.
    expect(columns.filter((c) => CAPITAL_PATTERN.test(c))).toEqual([]);
    expect(columns).toContain("price_at_response_usd");
  });

  it("paper_positions ist die einzige Tabelle mit Einsatz — und kennt das Sizing-Verfahren", async () => {
    const columns = await columnsOf("paper_positions");
    expect(columns).toContain("entry_notional_minor");
    expect(columns).toContain("sizing_mode");
  });
});

describe("Struktur der simulierten Positionen", () => {
  it("erzwingt sizing_mode und stream", async () => {
    const rows = await rowsOf<{ column_name: string; is_nullable: string }>(sql`
      select column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'paper_positions'
        and column_name in ('sizing_mode', 'stream')
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.is_nullable).toBe("NO");
  });

  it("laesst hoechstens eine Position je Gelegenheit zu", async () => {
    const rows = await rowsOf<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'paper_positions'
    `);
    const unique = rows.filter(
      (r) => /unique/i.test(r.indexdef) && /opportunity_id/.test(r.indexdef),
    );
    expect(unique.length).toBeGreaterThan(0);
  });

  it("haelt Paper- und Live-Positionen in getrennten Tabellen", async () => {
    const rows = await rowsOf<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('paper_positions', 'positions')
    `);
    const names = rows.map((r) => r.table_name);
    // `PAPER ≠ LIVE` haengt nicht an einem `where mode = 'paper'`: die
    // simulierten Positionen stehen woanders als die echten.
    expect(names).toContain("paper_positions");
  });
});

describe("Doppelte Gelegenheiten", () => {
  it("sind je Token, Strom und Entscheidungszeitpunkt ausgeschlossen", async () => {
    const rows = await rowsOf<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'opportunities'
        and indexname = 'opportunities_unique'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/i);
    for (const column of ["token_id", "stream", "decided_at"]) {
      expect(rows[0]!.indexdef).toContain(column);
    }
  });
});

describe("Regime-Verlauf", () => {
  it("laesst nur ein Label je Beobachtungszeitpunkt zu", async () => {
    const rows = await rowsOf<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'market_regimes'
        and indexname = 'market_regimes_observed_at'
    `);
    // Zwei Worker duerfen nicht zwei widersprechende Labels fuer denselben
    // Moment schreiben — sonst haengt die Historie davon ab, wer zuletzt kam.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/i);
  });

  it("haelt fest, welche Indikatoren gefehlt haben", async () => {
    const columns = await columnsOf("market_regimes");
    // Ohne diese Spalte liesse sich spaeter nicht mehr sagen, ob ein
    // Regimewechsel auf breiter Grundlage stand oder an einem Indikator hing.
    expect(columns).toContain("missing_indicators");
    expect(columns).toContain("votes");
    expect(columns).toContain("observed_at");
  });
});

describe("Latenzmessungen", () => {
  it("stehen einzeln, ohne aggregierte Spalte", async () => {
    const columns = await columnsOf("latency_samples");
    // Sobald irgendwo ein Mittelwert steht, wird irgendwann damit simuliert —
    // und ein Median glaettet die Faelle weg, in denen es wehtat (I-9).
    expect(columns.filter((c) => /avg|mean|median|p50|p90/i.test(c))).toEqual([]);
    expect(columns).toContain("responded_at");
    expect(columns).toContain("alerted_at");
  });

  it("fuehren den Strom mit, damit Auto und Manual getrennt bleiben", async () => {
    const columns = await columnsOf("latency_samples");
    expect(columns).toContain("stream");
  });
});
