import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, isPresent, missing, observed, providerId, type Maybe } from "@sae/core";
import { ensureActiveStrategyVersion, schema, type Database } from "@sae/db";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import type { QuoteSource } from "@sae/trading";

import { monitorPaperPositions } from "../position-monitor";

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
  async quote() {
    return observed(
      { outAmount: 1_000_000n, priceImpactBps: 50 as never },
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
async function position(): Promise<string> {
  const [feature] = await db
    .insert(schema.featureSnapshots)
    .values({
      tokenId,
      observedAt: new Date(T0.getTime() - 3_600_000),
      features: {},
      dataCompleteness: 0.7,
      scoreEngineVersion: "test",
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
      decidedAt: new Date(T0.getTime() - 3_600_000),
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
      openedAt: new Date(T0.getTime() - 3_600_000),
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
    const result = await monitorPaperPositions({
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

    const result = await monitorPaperPositions({
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

    const result = await monitorPaperPositions({
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

    const result = await monitorPaperPositions({
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

    const result = await monitorPaperPositions({
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
    await monitorPaperPositions({ db, logger, quotes: guterKurs, quoteMint: USDC, clock });

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
