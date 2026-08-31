import { describe, expect, it } from "vitest";

import {
  MAX_ACCEPTABLE_RISK_OF_RUIN,
  MIN_TRADES_FOR_MONTE_CARLO,
  runMonteCarlo,
  ruinGate,
} from "../monte-carlo";

/** Typische Memecoin-Verteilung: viele kleine Verluste, seltene grosse Gewinner. */
function skewedSample(count = 200): number[] {
  return Array.from({ length: count }, (_, i) => (i % 10 === 0 ? 3.0 : -0.25));
}

/** Gleichmaessig leicht positiv — ohne Ausreisser. */
function steadySample(count = 200): number[] {
  return Array.from({ length: count }, (_, i) => (i % 3 === 0 ? -0.2 : 0.15));
}

describe("Monte Carlo", () => {
  it("liefert bei gleichem Seed dasselbe Ergebnis", () => {
    const a = runMonteCarlo(skewedSample(), { paths: 300, seed: 42 });
    const b = runMonteCarlo(skewedSample(), { paths: 300, seed: 42 });
    // Ein Lauf, der sich bei Wiederholung aendert, ist keine Messung.
    expect(a.riskOfRuin).toBe(b.riskOfRuin);
    expect(a.equityMedian).toBe(b.equityMedian);
    expect(a.drawdownP95).toBe(b.drawdownP95);
  });

  it("erfindet nichts aus einer zu kleinen Stichprobe", () => {
    const result = runMonteCarlo(skewedSample(20));
    expect(result.verdict).toBe("TOO_LITTLE_DATA");
    expect(result.riskOfRuin).toBeNull();
    expect(result.note).toMatch(/Sicherheit, die es nicht gibt/);
    expect(MIN_TRADES_FOR_MONTE_CARLO).toBeGreaterThan(10);
  });

  it("zeigt bei unabhaengiger Ziehung freundlichere Rueckgaenge als bei Bloecken", () => {
    // Der Kern des Block-Bootstraps: unabhaengiges Ziehen zerlegt jede
    // Verlustserie und beschoenigt damit den Drawdown.
    const clustered = [
      ...Array.from({ length: 60 }, () => -0.3),
      ...Array.from({ length: 140 }, () => 0.2),
    ];
    const iid = runMonteCarlo(clustered, { paths: 400, seed: 7, resample: "IID" });
    const block = runMonteCarlo(clustered, {
      paths: 400,
      seed: 7,
      resample: "BLOCK",
      blockLength: 20,
    });

    expect(block.drawdownP95!).toBeGreaterThan(iid.drawdownP95!);
  });

  it("erkennt eine Verteilung mit hohem Ruinrisiko", () => {
    // Fast nur Verluste — bei anteiligem Einsatz faellt das Konto durch.
    const losing = Array.from({ length: 200 }, (_, i) => (i % 20 === 0 ? 1.0 : -0.4));
    const result = runMonteCarlo(losing, { paths: 500, seed: 3, stakeFraction: 0.2 });

    expect(result.verdict).toBe("MEASURED");
    expect(result.riskOfRuin!).toBeGreaterThan(0.1);
    expect(ruinGate(result).passed).toBe(false);
  });

  it("laesst ein breit getragenes Ergebnis durch das Gate", () => {
    const result = runMonteCarlo(steadySample(), {
      paths: 500,
      seed: 11,
      stakeFraction: 0.02,
    });
    expect(result.riskOfRuin!).toBeLessThanOrEqual(MAX_ACCEPTABLE_RISK_OF_RUIN);
    expect(ruinGate(result).passed).toBe(true);
  });

  it("behandelt eine fehlende Stichprobe als nicht bestanden, nicht als unbekannt", () => {
    // Ohne Grundlage gibt es keinen Anlass, echtes Geld zu riskieren.
    const gate = ruinGate(runMonteCarlo([0.1, -0.1]));
    expect(gate.passed).toBe(false);
  });

  it("unterscheidet festen von anteiligem Einsatz", () => {
    const fixed = runMonteCarlo(skewedSample(), {
      paths: 400,
      seed: 5,
      stakeMode: "FIXED",
      stakeFraction: 0.03,
    });
    const compound = runMonteCarlo(skewedSample(), {
      paths: 400,
      seed: 5,
      stakeMode: "COMPOUND",
      stakeFraction: 0.03,
    });
    // Verschiedene Verteilungen — deshalb wird nie ueber beide gemittelt.
    expect(fixed.equityP95).not.toBe(compound.equityP95);
  });

  it("gibt die Streuung des Endkapitals in Perzentilen aus", () => {
    const result = runMonteCarlo(skewedSample(), { paths: 500, seed: 9 });
    expect(result.equityP05!).toBeLessThanOrEqual(result.equityMedian!);
    expect(result.equityMedian!).toBeLessThanOrEqual(result.equityP95!);
    expect(result.drawdownMedian!).toBeLessThanOrEqual(result.drawdownP95!);
  });
});
