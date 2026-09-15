import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, eur, isPresent, missing, observed, providerId, type Maybe } from "@sae/core";
import { ensureActiveStrategyVersion, PaperPositionRepository, schema, type Database } from "@sae/db";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import type { QuoteSource } from "@sae/trading";

import { monitorPaperPositions, type PositionMonitorDeps } from "../position-monitor";

/**
 * Die Ueberwachung offener Papier-Positionen.
 *
 * Geprueft wird vor allem, wann NICHT geschlossen wird. Eine Position ohne
 * Ausstiegspreis zu schliessen hiesse, den Gewinn zu erfinden — und eine
 * erfundene Zahl in der Papier-Statistik macht die ganze spaetere Forschung
 * wertlos.
 */

const T0 = new Date("2026-09-11T12:00:00Z");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const logger = createLogger({ service: "test", level: "error" });

// Explicit deterministic fixture inputs, never production currency observations.
const monitor = (deps: PositionMonitorDeps) => monitorPaperPositions({
  solPrice: eur(150), random: () => 1,
  valueFill: async ({ amountRaw, currency, at }) => ({
    proceeds: { minor: amountRaw * 7_000n / 1_000_000n, currency },
    observedAt: at, source: "TEST_FIXTURE_VALUATION",
  }),
  ...deps,
});

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

/** Eine Kursquelle, die immer liefert — der Ausstieg soll gelingen. */
const guterKurs: QuoteSource = {
  async quote(plan) {
    return observed(
      { outAmount: plan.inAmount, priceImpactBps: 50 as never },
      providerId("jupiter"),
      T0,
    ) as Maybe<{ outAmount: bigint; priceImpactBps: never }>;
  },
};

/** Eine, die ehrlich nichts weiss. */
const keinKurs: QuoteSource = {
  async quote() {
    return missing("PROVIDER_DOWN", T0, null);
  },
};

async function snapshot(preis: number, minutenVorher: number, key: string): Promise<void> {
  await db.insert(schema.tokenSnapshots).values({
    tokenId,
    observedAt: new Date(T0.getTime() - minutenVorher * 60_000),
    priceUsd: preis,
    liquidityUsd: 180_000,
    dataCompleteness: 0.5,
    sourceProviderId: "jupiter-quote",
    sourceTier: "PRIMARY",
    ingestKey: key,
  });
}

/**
 * Eine offene Position mit Einstieg vor einer Stunde.
 *
 * Der Umweg ueber Feature-Snapshot und Gelegenheit ist kein Ballast: die
 * Fremdschluessel sind Invarianten, und ein Test, der sie umgeht, prueft eine
 * Datenlage, die es in der Produktion nicht geben kann.
 */
async function position(offsetMs = 0): Promise<string> {
  const [feature] = await db
    .insert(schema.featureSnapshots)
    .values({
      tokenId,
      observedAt: new Date(T0.getTime() - 3_600_000 + offsetMs),
      features: {},
      dataCompleteness: 0.7,
      scoreEngineVersion: `test-${strategyId}`,
      featureSetVersion: "test",
      inputHash: `hash-${String(Math.random())}`,
    })
    .returning({ id: schema.featureSnapshots.id });

  const [opp] = await db
    .insert(schema.opportunities)
    .values({
      tokenId,
      strategyVersionId: strategyId,
      featureSnapshotId: feature!.id,
      stream: "AUTO_PAPER",
      state: "POSITION_OPENED",
      decisionKind: "ENTER",
      decidedAt: new Date(T0.getTime() - 3_600_000 + offsetMs),
    })
    .returning({ id: schema.opportunities.id });

  const [pos] = await db
    .insert(schema.paperPositions)
    .values({
      opportunityId: opp!.id,
      tokenId,
      stream: "AUTO_PAPER",
      sizingMode: "FIXED_100",
      entryNotionalMinor: 10_000n,
      currency: "EUR",
      entryAmountRaw: 1_000_000n,
      remainingAmountRaw: 1_000_000n,
      strategyVersionId: strategyId,
      openedAt: new Date(T0.getTime() - 3_600_000 + offsetMs),
      sourceType: "LIVE",
    })
    .returning({ id: schema.paperPositions.id });
  return pos!.id;
}

beforeEach(async () => {
  await db.delete(schema.paperPositionEvents);
  await db.delete(schema.paperPositions);
  await db.delete(schema.opportunities);
  await db.delete(schema.featureSnapshots);
  await db.delete(schema.tokenSnapshots);
  await db.delete(schema.tokens);

  // Ueber den Bootstrap statt von Hand: `strategy_versions` haengt an einer
  // Strategie, und ein handgeschriebenes INSERT umgeht genau die Invariante,
  // die es dafuer gibt.
  const strategie = await ensureActiveStrategyVersion({
    db,
    parameters: DEFAULT_STRATEGY_PARAMETERS,
    at: T0,
  });
  strategyId = strategie.id;

  const [t] = await db
    .insert(schema.tokens)
    .values({ mint: MEME, discoverySource: "dexscreener", state: "SCREENING" })
    .returning({ id: schema.tokens.id });
  tokenId = t!.id;
});

describe("Papier-Positionen ueberwachen", () => {
  it("meldet ohne offene Positionen, dass es nichts zu tun gibt", async () => {
    const result = await monitor({
      db,
      logger,
      quotes: guterKurs,
      quoteMint: USDC,
      clock: new FixedClock(T0),
    });
    expect(result.status).toBe("NO_POSITIONS");
  });

  it("haelt eine Position, die im Rahmen laeuft", async () => {
    await position();
    // Einstieg 1,00 — jetzt 1,05. Weder Stop noch Take Profit.
    await snapshot(1.0, 60, "einstieg");
    await snapshot(1.05, 0, "jetzt");

    const result = await monitor({
      db,
      logger,
      quotes: guterKurs,
      quoteMint: USDC,
      clock: new FixedClock(T0),
    });
    expect(result.closed).toBe(0);
    expect(result.decisions["HOLD"]).toBe(1);
  });

  it("schliesst beim Stop Loss", async () => {
    const id = await position();
    // Einstieg 1,00 — jetzt 0,70. Der Stop liegt bei 20 %.
    await snapshot(1.0, 60, "einstieg");
    await snapshot(0.7, 0, "jetzt");

    const result = await monitor({
      db,
      logger,
      quotes: guterKurs,
      quoteMint: USDC,
      clock: new FixedClock(T0),
    });
    expect(result.closed).toBe(1);

    const [row] = await db
      .select({
        closedAt: schema.paperPositions.closedAt,
        reason: schema.paperPositions.exitReason,
        mae: schema.paperPositions.maxAdverseExcursion,
      })
      .from(schema.paperPositions)
      .limit(1);
    expect(row?.closedAt).not.toBeNull();
    expect(row?.reason).not.toBeNull();
    // Der tiefste Punkt wird festgehalten, nicht nur der Schlusskurs.
    expect(row?.mae).toBeCloseTo(0.7, 6);
    expect(id).toBeTruthy();
  });

  /**
   * Der wichtigste Test der Datei.
   *
   * Die Regeln sagen „aussteigen", aber es gibt keinen Kurs. Die Position
   * bleibt offen. Sie zu schliessen hiesse, einen Ausstiegspreis zu erfinden —
   * und damit einen Gewinn, den es nie gab.
   */
  it("schliesst NICHT, wenn kein Ausstiegskurs zu bekommen ist", async () => {
    await position();
    await snapshot(1.0, 60, "einstieg");
    await snapshot(0.7, 0, "jetzt");

    const result = await monitor({
      db,
      logger,
      quotes: keinKurs,
      quoteMint: USDC,
      clock: new FixedClock(T0),
    });
    expect(result.closed).toBe(0);
    expect(result.decisions["EXIT_ABORTED"]).toBe(1);

    const [row] = await db
      .select({ closedAt: schema.paperPositions.closedAt })
      .from(schema.paperPositions)
      .limit(1);
    expect(row?.closedAt).toBeNull();
  });

  it("schliesst NICHT ohne Preise", async () => {
    // Keine Snapshots: kein Verhaeltnis, keine Entscheidung. Ein geschaetztes
    // waere hier besonders teuer — es loest Stop Loss und Take Profit aus.
    await position();

    const result = await monitor({
      db,
      logger,
      quotes: guterKurs,
      quoteMint: USDC,
      clock: new FixedClock(T0),
    });
    expect(result.closed).toBe(0);
    expect(result.decisions["NO_PRICE"]).toBe(1);
  });

  it("schreibt das Hoch fort, auch wenn gehalten wird", async () => {
    await position();
    await snapshot(1.0, 60, "einstieg");
    await snapshot(1.15, 0, "jetzt");

    const clock = new FixedClock(T0);
    await monitor({ db, logger, quotes: guterKurs, quoteMint: USDC, clock });

    const [row] = await db
      .select({ mfe: schema.paperPositions.maxFavorableExcursion })
      .from(schema.paperPositions)
      .limit(1);
    // Der hoechste Punkt liegt zwischen Einstieg und Ausstieg. Wer ihn erst
    // beim Schliessen ausliest, misst nur den Schluss.
    expect(row?.mfe).toBeCloseTo(1.15, 6);
  });
});

describe("Kursquelle", () => {
  it("liefert im Test tatsaechlich einen Kurs", () => {
    // Absicherung des Testaufbaus selbst: waere `guterKurs` kaputt, saehen
    // alle Ausstiegstests wie „kein Kurs" aus und waeren trotzdem gruen.
    expect(isPresent(observed({ outAmount: 1n, priceImpactBps: 1 }, providerId("x"), T0))).toBe(true);
  });
});


describe("Versionen und verbuchte Verkaeufe", () => {
  it("verbucht beim Ausstieg Quote-Erloes, Restbestand und Kosten gemeinsam", async () => {
    await position();
    await snapshot(1, 60, "entry");
    await snapshot(0.7, 0, "current");
    await monitor({ db, logger, quotes: guterKurs, quoteMint: USDC, clock: new FixedClock(T0) });
    const [row] = await db.select().from(schema.paperPositions);
    expect(row?.remainingAmountRaw).toBe(0n);
    expect(row?.realizedPnlMinor).toBe(-3_000n);
    expect(row?.costsPaidMinor).toBeGreaterThan(0n);
    expect(row?.closedAt).not.toBeNull();
    const events = await db.select().from(schema.paperPositionEvents);
    expect(events.map((e) => e.kind).sort()).toEqual(["CLOSED", "EXIT_FILL"]);
  });

  it("fuehrt uebersprungene Teilstufen aus und wiederholt sie nach Neustart nicht", async () => {
    await position();
    await snapshot(1, 60, "entry");
    await snapshot(1.6, 0, "current");
    const deps = { db, logger, quotes: guterKurs, quoteMint: USDC, clock: new FixedClock(T0) };
    await monitor(deps);
    const [first] = await db.select().from(schema.paperPositions);
    expect(first?.remainingAmountRaw).toBe(600_000n);
    expect(first?.closedAt).toBeNull();
    await monitor(deps);
    const [second] = await db.select().from(schema.paperPositions);
    expect(second?.remainingAmountRaw).toBe(600_000n);
    expect(second?.realizedPnlMinor).toBe(first?.realizedPnlMinor);
    const events = await db.select().from(schema.paperPositionEvents);
    expect(events.filter((e) => e.kind === "PARTIAL_TP")).toHaveLength(2);
  });

  it("bewertet gleichzeitig offene Positionen mit ihrer eigenen Strategieversion", async () => {
    const old = await position();
    const [original] = await db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, strategyId));
    const [version] = await db.insert(schema.strategyVersions).values({
      strategyId: original!.strategyId, version: "monitor-fixture-1", retiredAt: T0,
      parameters: { ...DEFAULT_STRATEGY_PARAMETERS, exit: { ...DEFAULT_STRATEGY_PARAMETERS.exit, stopLossBps: 500 } },
      reason: "Explicit test fixture for independent exit policies",
    }).returning();
    strategyId = version!.id;
    const newer = await position(1_000);
    await snapshot(1, 60, "entry");
    await snapshot(0.9, 0, "current");
    await monitor({ db, logger, quotes: guterKurs, quoteMint: USDC, clock: new FixedClock(T0) });
    const rows = await db.select().from(schema.paperPositions);
    expect(rows.find((r) => r.id === old)?.closedAt).toBeNull();
    expect(rows.find((r) => r.id === newer)?.closedAt).not.toBeNull();
  });

  it("erfindet ohne Bewertung des erhaltenen Ankers keinen Gewinn", async () => {
    await position();
    await snapshot(1, 60, "entry");
    await snapshot(0.7, 0, "current");
    const result = await monitor({ db, logger, quotes: guterKurs, quoteMint: USDC, clock: new FixedClock(T0), valueFill: async () => null });
    expect(result.decisions["NO_VALUATION"]).toBe(1);
    const [row] = await db.select().from(schema.paperPositions);
    expect(row?.closedAt).toBeNull();
    expect(row?.remainingAmountRaw).toBe(1_000_000n);
  });
});


it("conserves cents across partial fills and rejects replay of the same version", async () => {
  const id = await position();
  await db.update(schema.paperPositions).set({ entryAmountRaw: 3n, remainingAmountRaw: 3n }).where(eq(schema.paperPositions.id, id));
  const repo = new PaperPositionRepository(db);
  const sale = {
    positionId: id, expectedVersion: 0, soldAmountRaw: 1n,
    proceeds: eur(34), costs: eur(0.01), at: T0, reason: "TEST_SALE", levelIndex: 1,
    maxAdverseExcursion: 1, maxFavorableExcursion: 1.02, valuation: { source: "TEST_FIXTURE" },
  };
  expect((await repo.settleSale(sale)).kind).toBe("SETTLED");
  expect((await repo.settleSale(sale)).kind).toBe("STALE");
  await repo.settleSale({ ...sale, expectedVersion: 1, levelIndex: 2 });
  await repo.settleSale({ ...sale, expectedVersion: 2, levelIndex: 3 });
  const [row] = await db.select().from(schema.paperPositions);
  expect(row?.remainingAmountRaw).toBe(0n);
  expect(row?.realizedPnlMinor).toBe(200n);
  expect(row?.costsPaidMinor).toBe(3n);
  expect(row?.closedAt).not.toBeNull();
  const events = await db.select().from(schema.paperPositionEvents);
  expect(events.filter((e) => e.kind === "CLOSED")).toHaveLength(1);
});

it("rejects a stale snapshot before requesting a sale quote", async () => {
  await position();
  await snapshot(1, 60, "entry");
  await snapshot(0.7, 3, "old");
  let calls = 0;
  const result = await monitor({ db, logger, quoteMint: USDC, clock: new FixedClock(T0),
    quotes: { quote: async (plan) => { calls += 1; return guterKurs.quote(plan); } } });
  expect(result.decisions["STALE_PRICE"]).toBe(1);
  expect(calls).toBe(0);
});

it("books failed-exit costs without selling tokens or marking a take-profit hit", async () => {
  const id = await position();
  await snapshot(1, 60, "failed-entry-reference");
  await snapshot(.7, 0, "failed-exit-reference");
  await monitor({ db, logger, quotes: guterKurs, quoteMint: USDC, clock: new FixedClock(T0), random: () => 0 });
  const [row] = await db.select().from(schema.paperPositions).where(eq(schema.paperPositions.id, id));
  expect(row?.remainingAmountRaw).toBe(1_000_000n);
  expect(row?.closedAt).toBeNull();
  expect(row!.costsPaidMinor).toBeGreaterThan(0n);
  const events = await db.select().from(schema.paperPositionEvents).where(eq(schema.paperPositionEvents.positionId, id));
  expect(events.some((event) => event.kind === "EXIT_FAILED")).toBe(true);
  expect(events.some((event) => event.kind === "PARTIAL_TP")).toBe(false);
});
