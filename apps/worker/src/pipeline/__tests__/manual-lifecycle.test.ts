import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { OpportunityRepository, PaperPositionRepository, schema, type Database } from "@sae/db";
import { eur } from "@sae/core";
import { computeCategoryStatistics, splitByProvenance, type PaperTradeRecord } from "@sae/analytics";

import { runOpportunityPipeline } from "../opportunity-pipeline";
import { testFixtureRequest } from "../test-fixture";
import { createHarness, type Harness } from "./harness";

/**
 * Der Manual-Lebenszyklus und die beiden Invarianten, die daran haengen.
 *
 * Der Kern: eine Gelegenheit, die keine Position erzeugt hat, kann keine
 * Performance-Zeile erzeugen — nicht weil ein Filter sie ausschliesst, sondern
 * weil es die Zeile nicht gibt. Ein vergessener Filter ist ein Bug; eine
 * fehlende Zeile ist ein Zustand.
 *
 * Abbildung der geforderten Begriffe auf die Zustaende dieses Systems:
 *
 *   PENDING      → OFFERED
 *   SEEN         → SEEN
 *   CONFIRMED    → USER_CONFIRMED   (CONFIRMED ist in TradeState belegt)
 *   EXECUTED     → POSITION_OPENED  (EXECUTED ist ein Zustand der Position)
 *   REJECTED     → REJECTED
 *   EXPIRED      → EXPIRED
 *   INVALIDATED  → INVALIDATED
 *   CANCELLED    → CANCELLED
 *   MISSED       → keine State, sondern eine Klassifikation auf EXPIRED
 *                  (laesst sich erst nach dem Kursverlauf sagen)
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let h: Harness;
let db: Database;
let opportunities: OpportunityRepository;

beforeEach(async () => {
  h = await createHarness(T0);
  db = h.db;
  opportunities = new OpportunityRepository(db);
});

afterEach(async () => {
  await h.close();
});

/** Legt beide Stroeme an und gibt die Manual-Gelegenheit zurueck. */
async function manualOpportunity(label: string): Promise<string> {
  const result = await runOpportunityPipeline(
    testFixtureRequest({ tokenId: h.tokenId, label, asOf: T0 }),
    h.deps(),
  );
  if (result.kind !== "ENTERED") throw new Error(`Erwartet ENTERED, war ${result.kind}`);
  return result.created.find((c) => c.stream === "MANUAL_PAPER")!.opportunityId;
}

async function manualPositions(): Promise<number> {
  const rows = await db
    .select()
    .from(schema.paperPositions)
    .where(eq(schema.paperPositions.stream, "MANUAL_PAPER"));
  return rows.length;
}

describe("Manual-Lebenszyklus", () => {
  it("durchlaeuft OFFERED → SEEN → USER_CONFIRMED → POSITION_OPENED", async () => {
    const id = await manualOpportunity("lifecycle-happy");

    expect((await opportunities.transition({ opportunityId: id, from: "OFFERED", to: "SEEN", at: at(1_000) })).kind).toBe("OK");
    expect((await opportunities.transition({ opportunityId: id, from: "SEEN", to: "USER_CONFIRMED", at: at(2_000) })).kind).toBe("OK");

    // Erst JETZT darf eine Position entstehen — aus USER_CONFIRMED, nicht aus
    // OFFERED. Das ist der Unterschied zum Auto-Strom.
    const opened = await new PaperPositionRepository(db).open({
      opportunityId: id,
      tokenId: h.tokenId,
      stream: "MANUAL_PAPER",
      sizingMode: "FIXED_100",
      entryNotional: eur(100),
      entryAmountRaw: 1_000_000n,
      strategyVersionId: h.strategyVersionId,
      openedAt: at(3_000),
      fromState: "USER_CONFIRMED",
      sourceType: "TEST_FIXTURE",
      entryCostsMinor: 0n,
    });
    expect(opened.kind).toBe("OPENED");
    expect(await manualPositions()).toBe(1);
  });

  it("verweigert eine Position aus OFFERED heraus", async () => {
    const id = await manualOpportunity("lifecycle-no-shortcut");

    // Ohne Bestaetigung keine Position. Der Zustandswechsel im WHERE haelt das
    // durch, nicht eine Pruefung im Anwendungscode.
    const opened = await new PaperPositionRepository(db).open({
      opportunityId: id,
      tokenId: h.tokenId,
      stream: "MANUAL_PAPER",
      sizingMode: "FIXED_100",
      entryNotional: eur(100),
      entryAmountRaw: 1_000_000n,
      strategyVersionId: h.strategyVersionId,
      openedAt: at(3_000),
      fromState: "USER_CONFIRMED",
      sourceType: "TEST_FIXTURE",
      entryCostsMinor: 0n,
    });
    expect(opened.kind).toBe("NOT_CONFIRMED");
    expect(await manualPositions()).toBe(0);
  });

  for (const [name, from, to] of [
    ["REJECTED", "OFFERED", "REJECTED"],
    ["EXPIRED", "OFFERED", "EXPIRED"],
    ["CANCELLED", "OFFERED", "CANCELLED"],
    ["INVALIDATED", "SEEN", "INVALIDATED"],
  ] as const) {
    it(`erreicht ${name} und erzeugt dabei keine Position`, async () => {
      const id = await manualOpportunity(`lifecycle-${name}`);
      if (from === "SEEN") {
        await opportunities.transition({ opportunityId: id, from: "OFFERED", to: "SEEN", at: at(1_000) });
      }
      const result = await opportunities.transition({ opportunityId: id, from, to, at: at(2_000) });
      expect(result.kind).toBe("OK");

      const [row] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, id));
      expect(row?.state).toBe(to);
      expect(row?.closedAt).not.toBeNull();
      expect(await manualPositions()).toBe(0);
    });
  }

  it("laesst aus einem Endzustand keinen weiteren Wechsel zu", async () => {
    const id = await manualOpportunity("lifecycle-terminal");
    await opportunities.transition({ opportunityId: id, from: "OFFERED", to: "REJECTED", at: at(1_000) });

    const illegal = await opportunities.transition({
      opportunityId: id,
      from: "REJECTED",
      to: "USER_CONFIRMED",
      at: at(2_000),
    });
    expect(illegal.kind).toBe("ILLEGAL");
  });
});

describe("MISSED_IS_NOT_LOSS und USER_REJECTED_IS_NOT_LOSS", () => {
  /**
   * Der Nachweis laeuft ueber die Datenbank, nicht ueber eine Rechnung: es gibt
   * schlicht keine Zeile, aus der ein Verlust entstehen koennte.
   */
  for (const [label, state] of [
    ["USER_REJECTED", "REJECTED"],
    ["MISSED/EXPIRED", "EXPIRED"],
    ["INVALIDATED", "INVALIDATED"],
    ["CANCELLED", "CANCELLED"],
  ] as const) {
    it(`${label} erzeugt keine Zeile in paper_positions`, async () => {
      const id = await manualOpportunity(`pnl-${state}`);
      if (state === "INVALIDATED") {
        await opportunities.transition({ opportunityId: id, from: "OFFERED", to: "SEEN", at: at(1_000) });
        await opportunities.transition({ opportunityId: id, from: "SEEN", to: state, at: at(2_000) });
      } else {
        await opportunities.transition({ opportunityId: id, from: "OFFERED", to: state, at: at(2_000) });
      }

      const positions = await db
        .select()
        .from(schema.paperPositions)
        .where(
          and(
            eq(schema.paperPositions.opportunityId, id),
            eq(schema.paperPositions.stream, "MANUAL_PAPER"),
          ),
        );
      expect(positions).toHaveLength(0);

      // Die Gelegenheit bleibt aber erhalten — sie ist Forschungsmaterial fuer
      // die Auswertung verpasster Chancen.
      const [row] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, id));
      expect(row).toBeDefined();
      expect(row?.state).toBe(state);
    });
  }

  it("kennt keinen Weg von einem Nicht-Positionszustand in eine Kennzahl", async () => {
    // Auf Typebene: eine Kennzahl braucht einen abgeschlossenen Trade. Eine
    // abgelehnte Gelegenheit hat keinen — sie kann gar nicht eingesetzt werden.
    const records: readonly PaperTradeRecord[] = [];
    expect(() => computeCategoryStatistics(records, "EUR")).toThrow();
  });
});

describe("TEST_FIXTURE gelangt nicht in Produktionskennzahlen", () => {
  it("wirft, wenn ein Fixture-Trade in eine Kennzahl soll", async () => {
    const fixtureTrade = {
      stream: "AUTO_PAPER" as const,
      sizingMode: "FIXED_100" as const,
      sourceType: "TEST_FIXTURE" as const,
      trade: {
        mode: "paper" as const,
        tradeId: "fixture-1",
        tokenId: h.tokenId,
        openedAt: T0,
        closedAt: at(60_000),
        investedNotional: eur(100),
        grossPnl: eur(20),
        costs: eur(2),
        netPnl: eur(18),
        netReturn: 0.18,
        holdingPeriodMs: 60_000,
        exitReason: "TP1",
      },
    } as unknown as PaperTradeRecord;

    expect(() => computeCategoryStatistics([fixtureTrade], "EUR")).toThrow(/TEST_FIXTURE/);
  });

  it("trennt Fixture- von Produktionsdatensaetzen", () => {
    const base = {
      stream: "AUTO_PAPER" as const,
      sizingMode: "FIXED_100" as const,
      trade: {} as never,
    };
    const split = splitByProvenance([
      { ...base, sourceType: "LIVE" },
      { ...base, sourceType: "TEST_FIXTURE" },
      { ...base, sourceType: "BACKTEST" },
    ]);
    expect(split.production).toHaveLength(1);
    expect(split.nonProduction).toHaveLength(2);
  });
});
