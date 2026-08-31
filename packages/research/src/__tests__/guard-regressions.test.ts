import { describe, expect, it } from "vitest";
import { tokenId } from "@sae/core";
import type { BacktestDataSource } from "@sae/backtest";

import { LookAheadError, guardedSource } from "../counterfactuals";
import {
  BoundariesTamperedError,
  HypothesisBeforeFreezeError,
  assertBoundariesIntact,
  assertFrozenBefore,
  freezeBatch,
} from "../batches";
import { advanceCandidate, CandidateChainError } from "../candidates";
import type { StrategyCandidate } from "../candidates";

/**
 * Regressionen fuer eine Fehlerklasse, nicht fuer einzelne Fehler.
 *
 * Der urspruengliche Befund war eine Schranke, die synchron warf, obwohl ihre
 * Schnittstelle Promises zurueckgibt: jeder Aufrufer mit `.catch()` statt
 * `await` waere daran vorbeigelaufen. Diese Datei prueft alle Schranken des
 * Forschungsteils auf dieselbe Umgehung — und zwar so, wie ein nachlaessiger
 * Aufrufer sie benutzen wuerde.
 */

const T0 = new Date(Date.UTC(2026, 0, 1));
const day = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);
const TOKEN = tokenId("token-1");

const source: BacktestDataSource = {
  universeAt: async () => [TOKEN],
  featuresAt: async () => null,
  positionMarketAt: async () => null,
  quoteAt: async () => null,
};

describe("Look-Ahead-Schranke", () => {
  it("kommt als abgelehntes Promise an, nicht als synchroner Wurf", async () => {
    const guard = guardedSource(source);
    guard.setClock(T0);

    // Genau so benutzt sie ein nachlaessiger Aufrufer: ohne try/catch, ohne
    // await, nur mit einem angehaengten .catch().
    let caught: unknown = null;
    const promise = guard.source.positionMarketAt(TOKEN, 1, 1, 1, 0, day(5));
    expect(promise).toBeInstanceOf(Promise);
    await promise.catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(LookAheadError);
  });

  it("greift auf jeder Methode der Schnittstelle, nicht nur auf einer", async () => {
    const guard = guardedSource(source);
    guard.setClock(T0);
    const future = day(5);

    await expect(guard.source.universeAt(future)).rejects.toThrow(LookAheadError);
    await expect(guard.source.featuresAt(TOKEN, future)).rejects.toThrow(LookAheadError);
    await expect(
      guard.source.positionMarketAt(TOKEN, 1, 1, 1, 0, future),
    ).rejects.toThrow(LookAheadError);
    await expect(guard.source.quoteAt(TOKEN, 1n, future)).rejects.toThrow(LookAheadError);
  });

  it("laesst sich nicht durch Zuruecksetzen der Uhr aushebeln", async () => {
    const guard = guardedSource(source);
    guard.setClock(day(10));
    await expect(guard.source.universeAt(day(5))).resolves.toBeDefined();

    // Uhr zurueckgestellt: was vorher erlaubt war, ist es jetzt nicht mehr.
    guard.setClock(day(1));
    await expect(guard.source.universeAt(day(5))).rejects.toThrow(LookAheadError);
  });
});

describe("Schranken der Forschungsgrenzen", () => {
  const batch = freezeBatch({
    batchId: "b1",
    boundaries: {
      trainFrom: day(0),
      trainTo: day(60),
      oosFrom: day(62),
      oosTo: day(90),
      embargoSeconds: 86_400,
    },
    maxHoldingSeconds: 86_400,
    at: day(61),
  });

  it("wirft synchron — und die Schnittstelle ist auch synchron", () => {
    // Kein Promise im Spiel: hier gibt es die Umgehung nicht, und der Test
    // haelt fest, dass die Schnittstelle synchron bleibt.
    expect(assertFrozenBefore(batch, day(62))).toBeUndefined();
    expect(() => assertFrozenBefore(batch, day(30))).toThrow(HypothesisBeforeFreezeError);
  });

  it("erkennt verschobene Grenzen unabhaengig davon, welches Feld bewegt wurde", () => {
    for (const patch of [
      { trainFrom: day(5) },
      { trainTo: day(70) },
      { oosFrom: day(50) },
      { oosTo: day(120) },
      { embargoSeconds: 0 },
    ]) {
      expect(() => assertBoundariesIntact({ ...batch, ...patch })).toThrow(
        BoundariesTamperedError,
      );
    }
  });
});

describe("Schranke der Pruefkette", () => {
  const candidate: StrategyCandidate = {
    candidateId: "c1",
    state: "HYPOTHESIS",
    origin: "MANUAL",
    researchBatchId: "b1",
    hypothesis: "x",
    parameters: {},
    baseStrategyVersionId: "sv1",
    createdAt: T0,
    closedReason: null,
  };

  it("laesst sich nicht durch einen zweiten Aufruf umgehen", () => {
    // Ein Aufruf, dessen Fehler jemand faengt und der dann trotzdem
    // weitermacht, bekommt keinen veraenderten Kandidaten zurueck: die
    // Funktion ist rein und der Zustand bleibt, wo er war.
    expect(() => advanceCandidate(candidate, "PROMOTED")).toThrow(CandidateChainError);
    expect(candidate.state).toBe("HYPOTHESIS");
  });

  it("ist synchron und liefert kein Promise, das jemand vergessen koennte", () => {
    const result = advanceCandidate(candidate, "BACKTESTED");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.state).toBe("BACKTESTED");
  });
});
