import { describe, expect, it } from "vitest";
import { bps, eur, missing, observed, providerId, usd } from "@sae/core";
import {
  DEFAULT_FEES,
  DEFAULT_LATENCY,
  estimateExecutionCosts,
  estimateExecutionCostsFromObservations,
  formatCostBreakdown,
} from "../cost-model";

const SRC = providerId("test");
const T0 = new Date("2026-08-30T12:00:00Z");

const baseInput = {
  notional: eur(100),
  dexFeeBps: bps(30),
  priceImpactBps: bps(120),
  solPrice: eur(150),
  fees: DEFAULT_FEES,
  latency: DEFAULT_LATENCY,
};

describe("estimateExecutionCosts", () => {
  it("liefert eine stabile Aufschluesselung (Golden File)", () => {
    // Aendert sich dieser Snapshot unbeabsichtigt, verschiebt sich rueckwirkend
    // die gesamte Paper- und Backtest-Historie. Deshalb bricht CI hier.
    const e = estimateExecutionCosts(baseInput);
    expect({
      networkFeeLamports: e.networkFeeLamports.toString(),
      priorityFeeLamports: e.priorityFeeLamports.toString(),
      expectedFailureLamports: e.expectedFailureLamports.toString(),
      chainCosts: e.chainCosts.minor.toString(),
      dexFee: e.dexFee.minor.toString(),
      priceImpact: e.priceImpact.minor.toString(),
      latencyDrift: e.latencyDrift.minor.toString(),
      total: e.total.minor.toString(),
      totalBps: e.totalBps,
    }).toMatchInlineSnapshot(`
      {
        "chainCosts": "1",
        "dexFee": "30",
        "expectedFailureLamports": "1667",
        "latencyDrift": "50",
        "networkFeeLamports": "5000",
        "priceImpact": "120",
        "priorityFeeLamports": "10000",
        "total": "201",
        "totalBps": 201,
      }
    `);
  });

  it("setzt niemals Kosten von null an", () => {
    // Null-Kosten sind die klassische Backtest-Luege.
    const e = estimateExecutionCosts(baseInput);
    expect(e.total.minor).toBeGreaterThan(0n);
    expect(e.priorityFeeLamports).toBeGreaterThan(0n);
  });

  it("beruecksichtigt fehlgeschlagene Transaktionen als reale Kosten", () => {
    const withFailures = estimateExecutionCosts(baseInput);
    const withoutFailures = estimateExecutionCosts({
      ...baseInput,
      fees: { ...DEFAULT_FEES, failureRate: 0 },
    });
    // Auf Lamport-Ebene ist die Differenz exakt messbar. In der Fiat-Summe ist sie
    // es bei 100 EUR Volumen NICHT: Chain-Kosten liegen dort unter einem Cent und
    // verschwinden in der Rundung. Das ist kein Modellfehler, sondern ein Befund —
    // bei kleinen Positionen dominieren Impact und Drift, nicht die Netzwerkgebuehr.
    expect(withFailures.expectedFailureLamports).toBeGreaterThan(0n);
    expect(withoutFailures.expectedFailureLamports).toBe(0n);
    expect(withFailures.total.minor).toBeGreaterThanOrEqual(withoutFailures.total.minor);
  });

  it("macht Fehlversuche bei aktivem Tip sichtbar teuer", () => {
    // Chain-Kosten haengen nicht vom Volumen ab — sie skalieren mit Gebuehren und
    // Tip. Sobald ein Jito-Tip gesetzt ist, kostet jede fehlgeschlagene
    // Transaktion echtes Geld, und die Ausfallrate wird zu einem realen Posten.
    const tipped = { ...DEFAULT_FEES, tipLamports: 1_000_000n };
    const withFailures = estimateExecutionCosts({ ...baseInput, fees: tipped });
    const withoutFailures = estimateExecutionCosts({
      ...baseInput,
      fees: { ...tipped, failureRate: 0 },
    });
    expect(withFailures.chainCosts.minor).toBeGreaterThan(withoutFailures.chainCosts.minor);
    expect(withFailures.total.minor).toBeGreaterThan(withoutFailures.total.minor);
  });

  it("skaliert die Latenzdrift mit der Verzoegerung", () => {
    const fast = estimateExecutionCosts({
      ...baseInput,
      latency: { ...DEFAULT_LATENCY, quoteToFillMs: 500 },
    });
    const slow = estimateExecutionCosts({
      ...baseInput,
      latency: { ...DEFAULT_LATENCY, quoteToFillMs: 8_000 },
    });
    expect(slow.latencyDrift.minor).toBeGreaterThan(fast.latencyDrift.minor);
  });

  it("verweigert das Mischen von Waehrungen", () => {
    expect(() => estimateExecutionCosts({ ...baseInput, solPrice: usd(150) })).toThrow(TypeError);
  });

  it("lehnt eine Ausfallrate von 100 % ab", () => {
    expect(() =>
      estimateExecutionCosts({ ...baseInput, fees: { ...DEFAULT_FEES, failureRate: 1 } }),
    ).toThrow(RangeError);
  });

  it("weist die Kosten aufgeschluesselt aus", () => {
    expect(formatCostBreakdown(estimateExecutionCosts(baseInput))).toMatch(
      /DEX .* Impact .* Drift .* Chain/,
    );
  });
});

describe("estimateExecutionCostsFromObservations", () => {
  it("rechnet, wenn alle Beobachtungen vorliegen", () => {
    const r = estimateExecutionCostsFromObservations({
      notional: eur(100),
      dexFeeBps: observed(bps(30), SRC, T0),
      priceImpactBps: observed(bps(120), SRC, T0),
      solPrice: observed(eur(150), SRC, T0),
      fees: DEFAULT_FEES,
      latency: DEFAULT_LATENCY,
    });
    expect(r.ok).toBe(true);
  });

  it("liefert kein Ergebnis, wenn ein Input fehlt", () => {
    // Keine Schaetzung ohne Grundlage: ohne SOL-Preis sind die Chain-Kosten
    // schlicht unbekannt, und ein geratener Wert waere schlimmer als keiner.
    const r = estimateExecutionCostsFromObservations({
      notional: eur(100),
      dexFeeBps: observed(bps(30), SRC, T0),
      priceImpactBps: observed(bps(120), SRC, T0),
      solPrice: missing("PROVIDER_DOWN", T0),
      fees: DEFAULT_FEES,
      latency: DEFAULT_LATENCY,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("PROVIDER_DOWN");
  });
});
