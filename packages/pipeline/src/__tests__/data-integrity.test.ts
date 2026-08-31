import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_STATE, FixedClock, providerId, tokenId } from "@sae/core";
import { sourced, summarizeFleet, type ProviderStatusReport } from "@sae/providers";

import {
  InMemorySeenKeys,
  decideIngest,
  snapshotSupportsEntry,
  type MarketObservation,
} from "../ingestion";
import { evaluateReadiness, planBranches, signalValidity } from "../flow";

/**
 * Die beiden zusaetzlichen Integritaets-Invarianten, je als eigener Test.
 *
 * Sie stehen hier und nicht bei den vier Kategorien-Invarianten, weil sie eine
 * andere Stelle schuetzen: dort geht es um die Auswertung, hier um die Aufnahme.
 * Beides sind harte Bedingungen, keine Empfehlungen.
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const TOKEN = tokenId("token-1");
const market: MarketObservation = {
  priceUsd: 0.001,
  liquidityUsd: 100_000,
  marketCapUsd: 1_000_000,
  volume24hUsd: 200_000,
  holders: 500,
};

function report(status: ProviderStatusReport["status"]): ProviderStatusReport {
  return {
    providerId: providerId("market"),
    kind: "market",
    status,
    capabilities: ["TOKEN_MARKET"],
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    latencyMsP50: null,
    latencyMsP95: null,
    rateLimit: null,
    dataFreshnessSeconds: null,
    detail: null,
  };
}

describe("Invariante: FUTURE DATA MUST NEVER ENTER HISTORICAL DECISIONS", () => {
  it("weist eine Beobachtung mit Zeitstempel aus der Zukunft ab", async () => {
    // Ein Anbieter mit falsch gestellter Uhr wuerde sonst Daten in die Historie
    // schreiben, die es zum Entscheidungszeitpunkt noch nicht gab — und der
    // PitReader liefert sie spaeter brav aus.
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: sourced({
        value: market,
        providerId: providerId("market"),
        tier: "PRIMARY",
        observedAt: new Date(T0.getTime() + 3_600_000),
        fetchedAt: T0,
      }),
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });

    expect(decision.kind).toBe("REJECT_FUTURE");
  });

  it("weist sie unabhaengig davon ab, wie weit sie in der Zukunft liegt", async () => {
    for (const aheadSeconds of [10, 60, 86_400]) {
      const decision = await decideIngest({
        tokenId: TOKEN,
        sourcedValue: sourced({
          value: market,
          providerId: providerId("market"),
          tier: "PRIMARY",
          observedAt: new Date(T0.getTime() + aheadSeconds * 1_000),
          fetchedAt: T0,
        }),
        seen: new InMemorySeenKeys(),
        clock: new FixedClock(T0),
      });
      expect(decision.kind).toBe("REJECT_FUTURE");
    }
  });

  it("erzeugt aus einer abgewiesenen Beobachtung keinen Kandidaten", async () => {
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: sourced({
        value: market,
        providerId: providerId("market"),
        tier: "PRIMARY",
        observedAt: new Date(T0.getTime() + 60_000),
        fetchedAt: T0,
      }),
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });

    // Kein `candidate`-Feld: die abgewiesene Beobachtung kann gar nicht
    // versehentlich gespeichert werden.
    expect(Object.keys(decision)).not.toContain("candidate");
  });
});

describe("Invariante: LIVE DATA FAILURE MUST NEVER PRODUCE A VALID TRADE SIGNAL", () => {
  const blocked = summarizeFleet([report("BLOCKED")]);
  const connected = summarizeFleet([report("CONNECTED")]);
  const fresh = {
    providerId: providerId("market"),
    tier: "PRIMARY" as const,
    freshnessSeconds: 5,
    contributors: [],
  };

  it("erklaert jedes Signal ohne Marktdaten fuer ungueltig", () => {
    const v = signalValidity({ fleet: blocked, provenance: fresh });
    expect(v.valid).toBe(false);
  });

  it("laesst auch bei perfekter Datenqualitaet nichts durch, wenn die Quelle weg ist", () => {
    // Die Herkunft sagt „frisch und primaer" — die Quelle ist trotzdem weg.
    // Ein zwischengespeicherter Snapshot darf keine Entscheidung tragen.
    expect(snapshotSupportsEntry(fresh).allowed).toBe(true);
    expect(signalValidity({ fleet: blocked, provenance: fresh }).valid).toBe(false);
  });

  it("oeffnet ohne Marktdaten keinen einzigen Strom", () => {
    const plan = planBranches({
      readiness: evaluateReadiness({
        fleet: blocked,
        systemState: { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: true },
        snapshotCount: 100_000,
        minSnapshotsForAnalysis: 100,
      }),
      systemState: { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: true },
      provenance: fresh,
    });

    // Auch mit freigegebenem Live-Handel und voller Historie: nichts.
    expect(plan.openStreams).toEqual([]);
    expect(plan.producesAnything).toBe(false);
  });

  it("erzeugt bei leerer Kette keinen Snapshot als Ersatz", async () => {
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: null,
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });
    expect(decision.kind).toBe("REJECT_NO_SOURCE");
  });

  it("laesst ein Signal erst zu, wenn Quelle UND Daten stimmen", () => {
    expect(signalValidity({ fleet: connected, provenance: fresh }).valid).toBe(true);
  });
});

describe("Invariante: HISTORICAL PERFORMANCE ≠ GUARANTEED FUTURE PERFORMANCE", () => {
  it("laesst sich nicht als Code pruefen — und wird deshalb als Kette erzwungen", () => {
    // Diese Invariante ist eine Aussage ueber die Welt, nicht ueber den Code.
    // Was pruefbar ist: dass keine Stufe der Pipeline eine Freigabe erteilt.
    // Der Nachweis dafuer steht in den Promotionsgates (@sae/research), hier
    // steht nur die Verbindung: ohne Daten kommt gar nichts erst so weit.
    const readiness = evaluateReadiness({
      fleet: summarizeFleet([report("BLOCKED")]),
      systemState: DEFAULT_SYSTEM_STATE,
      snapshotCount: 0,
      minSnapshotsForAnalysis: 100,
    });

    expect(readiness.phase).toBe("WAITING_FOR_MARKET_DATA");
    expect(readiness.canAnalyze).toBe(false);
    expect(readiness.canLiveTrade).toBe(false);
  });
});
