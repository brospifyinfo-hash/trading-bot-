import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import type { Database } from "../../client";
import { smartMoneyWallets, tokenSecurity, tokenSnapshots, tokens } from "../../schema/index";
import { PostgresPitReader } from "../postgres-reader";
import { LivePitReader } from "../live-reader";
import { createTestDatabase } from "./harness";

/**
 * Der wichtigste Test des Systems.
 *
 * Ohne ihn ist jede Backtest-Zahl potenziell erfunden — und erfundene Zahlen sind
 * schlimmer als gar keine, weil auf sie Kapital gesetzt wird.
 */

const MINT = "So11111111111111111111111111111111111111112";
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 30, h, m, 0));
const DECISION_TIME = T(12);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());

  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;

  // Snapshots vor UND nach dem Entscheidungszeitpunkt.
  await db.insert(tokenSnapshots).values([
    { tokenId, observedAt: T(10), priceUsd: 1.0, liquidityUsd: 50_000, finalScore: 60, dataCompleteness: 0.9 },
    { tokenId, observedAt: T(11), priceUsd: 1.2, liquidityUsd: 60_000, finalScore: 72, dataCompleteness: 0.9 },
    // Exakt auf der Grenze — muss noch sichtbar sein (observedAt <= asOf).
    { tokenId, observedAt: T(12), priceUsd: 1.3, liquidityUsd: 65_000, finalScore: 75, dataCompleteness: 0.9 },
    // Zukunft aus Sicht der Entscheidung. Darf NIE zurueckkommen.
    { tokenId, observedAt: T(13), priceUsd: 9.9, liquidityUsd: 900_000, finalScore: 99, dataCompleteness: 1 },
    { tokenId, observedAt: T(14), priceUsd: 0.1, liquidityUsd: 1_000, finalScore: 5, dataCompleteness: 1 },
  ]);

  await db.insert(tokenSecurity).values([
    { tokenId, observedAt: T(9), checkVersion: "v1", riskLevel: "MEDIUM", securityScore: 70 },
    // Der Rug wurde erst NACH der Entscheidung sichtbar.
    { tokenId, observedAt: T(13, 30), checkVersion: "v1", riskLevel: "CRITICAL", securityScore: 5 },
  ]);

  await db.insert(smartMoneyWallets).values([
    // Vor der Entscheidung qualifiziert, noch aktiv.
    {
      address: "Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      qualifiedAt: T(8),
      methodVersion: "v1",
    },
    // Vor der Entscheidung qualifiziert, spaeter disqualifiziert — zaehlt fuer T(12).
    {
      address: "Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      qualifiedAt: T(8),
      disqualifiedAt: T(13),
      methodVersion: "v1",
    },
    // Erst NACH der Entscheidung qualifiziert. Der klassische Look-Ahead.
    {
      address: "Wa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      qualifiedAt: T(13),
      methodVersion: "v1",
    },
    // Bereits vor der Entscheidung disqualifiziert.
    {
      address: "Wa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      qualifiedAt: T(6),
      disqualifiedAt: T(9),
      methodVersion: "v1",
    },
  ]);
});

afterAll(async () => {
  await close();
});

describe("Backtest-Reader liefert keine Zukunftsdaten", () => {
  it("gibt den juengsten Snapshot bis einschliesslich asOf zurueck", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    const snap = await reader.snapshotAt(tokenId, DECISION_TIME);
    expect(snap?.observedAt).toEqual(T(12));
    expect(snap?.priceUsd).toBe(1.3);
  });

  it("liefert nie einen Snapshot mit observedAt > asOf", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    // Ueber die gesamte Zeitachse geprueft, nicht nur an einem Punkt.
    for (let hour = 8; hour <= 15; hour++) {
      const asOf = T(hour, 30);
      const snap = await reader.snapshotAt(tokenId, asOf);
      if (snap) {
        expect(snap.observedAt.getTime()).toBeLessThanOrEqual(asOf.getTime());
      }
    }
  });

  it("gibt gar nichts zurueck, wenn alle Daten spaeter liegen", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    // Kein Datensatz heisst kein Datensatz — nicht "nimm den naechstbesten".
    expect(await reader.snapshotAt(tokenId, T(9))).toBeNull();
  });

  it("begrenzt auch Zeitreihen sauber nach oben", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    const series = await reader.snapshotsBetween(tokenId, T(9), DECISION_TIME);
    expect(series.map((s) => s.observedAt.getUTCHours())).toEqual([10, 11, 12]);
    for (const s of series) {
      expect(s.observedAt.getTime()).toBeLessThanOrEqual(DECISION_TIME.getTime());
    }
  });

  it("kennt einen erst spaeter entdeckten Rug zum Entscheidungszeitpunkt nicht", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    const sec = await reader.securityAt(tokenId, DECISION_TIME);
    // Waere hier CRITICAL zu sehen, wuerde der Backtest so tun, als haette das
    // System den Rug vorhergesehen — und jede Ablehnungsstatistik waere falsch.
    expect(sec?.riskLevel).toBe("MEDIUM");
    expect(sec?.observedAt).toEqual(T(9));
  });
});

describe("Smart-Money-Look-Ahead", () => {
  it("zaehlt nur Wallets, die zum Entscheidungszeitpunkt bereits qualifiziert waren", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    const wallets = await reader.smartMoneyQualifiedAt(DECISION_TIME);
    expect(wallets.sort()).toEqual([
      "Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ]);
  });

  it("schliesst spaeter qualifizierte Wallets aus", async () => {
    // Der haeufigste unentdeckte Look-Ahead in Wallet-Intelligence: die heutige
    // Gewinnerliste auf die Vergangenheit anwenden.
    const reader = new PostgresPitReader(db, "backtest");
    const wallets = await reader.smartMoneyQualifiedAt(DECISION_TIME);
    expect(wallets).not.toContain("Wa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
  });

  it("schliesst bereits vorher disqualifizierte Wallets aus", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    const wallets = await reader.smartMoneyQualifiedAt(DECISION_TIME);
    expect(wallets).not.toContain("Wa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
  });

  it("entwertet die Vergangenheit nicht durch eine spaetere Disqualifikation", async () => {
    const reader = new PostgresPitReader(db, "backtest");
    const before = await reader.smartMoneyQualifiedAt(T(12));
    const after = await reader.smartMoneyQualifiedAt(T(14));
    expect(before).toContain("Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(after).not.toContain("Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  });
});

describe("Live-Reader", () => {
  it("verlangt auch im Livebetrieb einen ausdruecklichen Zeitpunkt", async () => {
    // Eine fruehere Fassung hatte `asOf` als Default aus der Uhr. Das war ein
    // Loch in genau der Vorkehrung, um die es geht: ohne Zeitpunkt aufrufbar zu
    // sein macht aus dem Reader wieder eine „aktueller Stand"-Methode.
    const clock = new FixedClock(DECISION_TIME);
    const reader = new LivePitReader(db, clock);

    // Die Zusicherung ist der Typecheck, nicht der Lauf: die Funktion wird nie
    // aufgerufen. Faellt die Pflichtangabe weg, meldet tsc die Direktive unten
    // als unbenutzt und der Build bricht.
    const neverCalled = async (): Promise<unknown> => {
      // @ts-expect-error asOf ist Pflicht — ein Aufruf ohne Zeitpunkt ist ein Compile-Fehler.
      return reader.snapshotAt(tokenId);
    };
    expect(typeof neverCalled).toBe("function");

    const snap = await reader.snapshotAt(tokenId, reader.now());
    expect(snap?.observedAt).toEqual(T(12));
  });

  it("filtert auch im Livebetrieb Daten aus der Zukunft weg", async () => {
    // Ein Provider mit falsch gestellter Uhr darf keine Entscheidung beeinflussen.
    const clock = new FixedClock(DECISION_TIME);
    const reader = new LivePitReader(db, clock);
    const series = await reader.snapshotsBetween(tokenId, T(9), reader.now());
    expect(series.every((s) => s.observedAt <= DECISION_TIME)).toBe(true);
  });

  it("liefert dieselben Ergebnisse wie der Backtest-Reader bei gleichem asOf", async () => {
    // Beide benutzen dieselbe Implementierung — dieser Test haelt das fest, damit
    // niemand spaeter einen zweiten, "schnelleren" Live-Pfad ohne Filter einzieht.
    const live = new LivePitReader(db, new FixedClock(DECISION_TIME));
    const backtest = new PostgresPitReader(db, "backtest");
    expect(await live.snapshotAt(tokenId, DECISION_TIME)).toEqual(
      await backtest.snapshotAt(tokenId, DECISION_TIME),
    );
  });
});
