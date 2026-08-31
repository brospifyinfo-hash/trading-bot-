import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATA_QUALITY_GATE,
  computeDataQuality,
  evaluateDataQualityGate,
  type DataQualityInputs,
} from "../data-quality";
import {
  computeCaseConfidence,
  combineConfidence,
  type CaseConfidenceInputs,
} from "../case-confidence";

const perfect: DataQualityInputs = {
  completeness: 1,
  oldestObservationAgeSeconds: 0,
  decisionLatencyMs: 0,
  contradictionCount: 0,
  degradedProviders: 0,
  requiredProviders: 4,
};

describe("Datenqualitaet", () => {
  it("beurteilt alle fuenf Dimensionen, wenn alles vorliegt", () => {
    const result = computeDataQuality(perfect);
    expect(result.assessed).toHaveLength(5);
    expect(result.unassessed).toEqual([]);
    expect(result.score).toBe(100);
  });

  it("bestraft alte Daten, auch wenn sie vollstaendig sind", () => {
    const stale = computeDataQuality({ ...perfect, oldestObservationAgeSeconds: 240 });
    // Genau der Fall, den `dataCompleteness` allein nicht sieht.
    expect(stale.score).toBeLessThan(100);
    expect(stale.perDimension.COMPLETENESS).toBe(100);
    expect(stale.perDimension.FRESHNESS).toBe(0);
    expect(stale.drivers.map((d) => d.code)).toContain("STALE_DATA");
  });

  it("macht aus einer ungeprueften Dimension keine bestandene", () => {
    const unchecked = computeDataQuality({ ...perfect, contradictionCount: null });

    // Weder gut noch schlecht gewertet: sie fehlt.
    expect(unchecked.unassessed).toContain("CONSISTENCY");
    expect(unchecked.perDimension.CONSISTENCY).toBeUndefined();
    expect(unchecked.drivers.map((d) => d.code)).toContain("CONSISTENCY_UNCHECKED");
    // Der Score der uebrigen vier bleibt sauber — er behauptet nur weniger.
    expect(unchecked.score).toBe(100);
  });

  it("faellt durch das Gate, wenn zu wenig ueberhaupt beurteilbar war", () => {
    const blind = computeDataQuality({
      completeness: 1,
      oldestObservationAgeSeconds: null,
      decisionLatencyMs: null,
      contradictionCount: null,
      degradedProviders: null,
      requiredProviders: 0,
    });

    expect(blind.score).toBe(100);
    // Ein perfekter Score aus einer einzigen Dimension ist kein Freibrief.
    expect(evaluateDataQualityGate(blind)).toEqual({
      kind: "FAIL",
      reason: "TOO_LITTLE_ASSESSED",
    });
  });

  it("laesst gute Dimensionen eine kaputte nicht ausgleichen", () => {
    const bad = computeDataQuality({ ...perfect, completeness: 0.2, contradictionCount: 5 });

    // Der Mittelwert kaeme auf 64 und damit ueber die Schwelle — obwohl vier
    // Fuenftel der Felder fehlen. Datenqualitaet ist nicht ausgleichbar.
    expect(bad.score).toBeGreaterThan(DEFAULT_DATA_QUALITY_GATE.minScore);
    expect(evaluateDataQualityGate(bad)).toEqual({
      kind: "FAIL",
      reason: "DIMENSION_TOO_LOW",
      dimension: "COMPLETENESS",
    });
  });

  it("faellt auch bei durchgehend mittelmaessigen Daten durch", () => {
    const mediocre = computeDataQuality({
      completeness: 0.5,
      oldestObservationAgeSeconds: 15,
      decisionLatencyMs: 1_000,
      contradictionCount: 1,
      degradedProviders: 2,
      requiredProviders: 4,
    });

    expect(evaluateDataQualityGate(mediocre)).toEqual({ kind: "FAIL", reason: "SCORE_TOO_LOW" });
    expect(evaluateDataQualityGate(computeDataQuality(perfect))).toEqual({ kind: "PASS" });
    expect(DEFAULT_DATA_QUALITY_GATE.minAssessedDimensions).toBeGreaterThan(1);
  });

  it("sieht einen ausgefallenen Provider trotz vollstaendiger Felder", () => {
    const degraded = computeDataQuality({ ...perfect, degradedProviders: 2 });
    expect(degraded.perDimension.PROVIDER_HEALTH).toBe(50);
    expect(degraded.drivers.map((d) => d.code)).toContain("PROVIDER_DEGRADED");
  });
});

const bucket: CaseConfidenceInputs = {
  bucketKey: "score:75-85|liq:high|age:<1h",
  caseCount: 500,
  spanDays: 60,
};

describe("Fallkonfidenz", () => {
  it("ist bei duenner Historie null", () => {
    const thin = computeCaseConfidence({ ...bucket, caseCount: 25 });
    expect(thin.score).toBe(0);
    expect(thin.note).toMatch(/keine Aussage/);
  });

  it("waechst mit der Fallzahl und saettigt", () => {
    const few = computeCaseConfidence({ ...bucket, caseCount: 100 });
    const many = computeCaseConfidence({ ...bucket, caseCount: 400 });
    const saturated = computeCaseConfidence({ ...bucket, caseCount: 5_000 });

    expect(many.score).toBeGreaterThan(few.score);
    expect(saturated.score).toBe(100);
  });

  it("laesst eine grosse Fallzahl die fehlende Streuung nicht zudecken", () => {
    // 500 Faelle aus zwei Tagen sind ein Marktzustand, keine Historie.
    const concentrated = computeCaseConfidence({ ...bucket, spanDays: 2 });
    expect(concentrated.score).toBeLessThan(20);
    expect(concentrated.note).toMatch(/ein Marktzustand/);
  });

  it("fuehrt die Bucket-Definition mit", () => {
    // Eine weitere Definition liefert mehr Faelle und damit hoehere Konfidenz,
    // ohne dass sich am Wissen etwas geaendert haette. Der Schluessel macht das
    // im Nachhinein sichtbar.
    expect(computeCaseConfidence(bucket).bucketKey).toBe(bucket.bucketKey);
  });
});

describe("Gesamtkonfidenz", () => {
  it("wird von der schwaecheren der beiden Groessen begrenzt", () => {
    // Viele Faelle, aber breite Ergebnisstreuung: das Muster trennt nicht.
    expect(
      combineConfidence({
        evIntervalConfidence: 0.2,
        caseConfidence: computeCaseConfidence(bucket).score,
      }),
    ).toBe(20);

    // Enge Streuung, aber kaum Faelle: wir wissen es noch nicht.
    expect(
      combineConfidence({
        evIntervalConfidence: 0.95,
        caseConfidence: computeCaseConfidence({ ...bucket, caseCount: 30 }).score,
      }),
    ).toBe(0);
  });
});
