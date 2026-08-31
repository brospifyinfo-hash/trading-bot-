import { describe, expect, it } from "vitest";

import {
  BoundariesInvalidError,
  BoundariesTamperedError,
  HypothesisBeforeFreezeError,
  MAX_INDEPENDENT_OVERLAP,
  areIndependent,
  assertBoundariesIntact,
  assertFrozenBefore,
  countIndependentConfirmations,
  freezeBatch,
  trainingOverlapFraction,
  validateBoundaries,
  type BatchBoundaries,
  type ResearchBatch,
} from "../batches";

const DAY = 86_400_000;
const T = (days: number): Date => new Date(Date.UTC(2026, 0, 1) + days * DAY);
const MAX_HOLDING = 86_400;

const sound: BatchBoundaries = {
  trainFrom: T(0),
  trainTo: T(60),
  oosFrom: T(62),
  oosTo: T(90),
  embargoSeconds: MAX_HOLDING,
};

function batch(id: string, boundaries: BatchBoundaries = sound, frozenDay = 61): ResearchBatch {
  return freezeBatch({
    batchId: id,
    boundaries,
    maxHoldingSeconds: MAX_HOLDING,
    at: T(frozenDay),
  });
}

describe("Zeitgrenzen", () => {
  it("nimmt eine saubere Aufteilung an", () => {
    expect(validateBoundaries(sound, MAX_HOLDING)).toEqual([]);
  });

  it("weist eine Pruefperiode vor dem Training zurueck", () => {
    const errors = validateBoundaries({ ...sound, oosFrom: T(30), oosTo: T(50) }, MAX_HOLDING);
    expect(errors).toContain("OOS_BEFORE_TRAIN");
  });

  it("verlangt eine Sperrfrist mindestens so lang wie die Haltedauer", () => {
    // Eine Position kurz vor trainTo laeuft sonst in den Pruefzeitraum hinein,
    // und ihr Ausgang gehoert beiden Bereichen.
    const errors = validateBoundaries({ ...sound, embargoSeconds: 60 }, MAX_HOLDING);
    expect(errors).toContain("EMBARGO_TOO_SHORT");
  });

  it("erkennt eine Sperrfrist, die der Pruefbereich unterlaeuft", () => {
    // Sperrfrist von einem Tag, aber OOS beginnt direkt nach dem Training.
    const errors = validateBoundaries(
      { ...sound, oosFrom: T(60), embargoSeconds: MAX_HOLDING },
      MAX_HOLDING,
    );
    expect(errors).toContain("OOS_BEFORE_TRAIN");
  });

  it("weist verdrehte Bereiche zurueck", () => {
    expect(validateBoundaries({ ...sound, trainTo: T(-1) }, MAX_HOLDING)).toContain(
      "TRAIN_RANGE_INVERTED",
    );
    expect(validateBoundaries({ ...sound, oosTo: T(61) }, MAX_HOLDING)).toContain(
      "OOS_RANGE_INVERTED",
    );
  });

  it("friert nur gueltige Grenzen ein", () => {
    expect(() =>
      freezeBatch({
        batchId: "b",
        boundaries: { ...sound, embargoSeconds: 0 },
        maxHoldingSeconds: MAX_HOLDING,
        at: T(61),
      }),
    ).toThrow(BoundariesInvalidError);
  });
});

describe("Reihenfolge von Einfrieren und Hypothese", () => {
  it("laesst eine Hypothese nach dem Einfrieren zu", () => {
    expect(() => assertFrozenBefore(batch("b1"), T(62))).not.toThrow();
  });

  it("weist eine Hypothese zurueck, die aelter ist als die Grenzen", () => {
    // Sonst koennten die Grenzen zu dem gewaehlt worden sein, was man schon
    // gesehen hat — und hinterher ist die Reihenfolge nicht rekonstruierbar.
    expect(() => assertFrozenBefore(batch("b1"), T(30))).toThrow(HypothesisBeforeFreezeError);
  });

  it("bemerkt nachtraeglich verschobene Grenzen", () => {
    const original = batch("b1");
    const moved: ResearchBatch = { ...original, oosFrom: T(40) };
    expect(() => assertBoundariesIntact(original)).not.toThrow();
    expect(() => assertBoundariesIntact(moved)).toThrow(BoundariesTamperedError);
  });
});

describe("Unabhaengigkeit zweier Batches", () => {
  it("misst den Anteil gemeinsamer Trainingszeit", () => {
    const a = batch("a", sound);
    const b = batch("b", { ...sound, trainFrom: T(30), trainTo: T(90), oosFrom: T(92), oosTo: T(120) }, 91);
    // 30 von 60 Tagen gemeinsam.
    expect(trainingOverlapFraction(a, b)).toBeCloseTo(0.5, 2);
    expect(areIndependent(a, b)).toBe(false);
  });

  it("nennt getrennte Bereiche unabhaengig", () => {
    const a = batch("a", sound);
    const b = batch("b", { trainFrom: T(90), trainTo: T(150), oosFrom: T(152), oosTo: T(180), embargoSeconds: MAX_HOLDING }, 151);
    expect(trainingOverlapFraction(a, b)).toBe(0);
    expect(areIndependent(a, b)).toBe(true);
  });

  it("zaehlt Wiederholungen ueber dieselben Daten nicht als Bestaetigung", () => {
    // „Drei Bestaetigungen" und „drei Bestaetigungen, davon zwei aus denselben
    // Daten" sind verschiedene Aussagen.
    const a = batch("a", sound);
    const nearlySame = batch(
      "a-again",
      { ...sound, trainFrom: T(2), trainTo: T(58), oosFrom: T(62), oosTo: T(90), embargoSeconds: MAX_HOLDING },
      61,
    );
    const later = batch(
      "later",
      { trainFrom: T(120), trainTo: T(180), oosFrom: T(182), oosTo: T(210), embargoSeconds: MAX_HOLDING },
      181,
    );

    const result = countIndependentConfirmations([a, nearlySame, later]);
    expect(result.independent).toEqual(["a", "later"]);
    expect(result.redundant).toEqual(["a-again"]);
  });

  it("fuehrt die Schwelle als benannte Konvention", () => {
    expect(MAX_INDEPENDENT_OVERLAP).toBeGreaterThan(0);
    expect(MAX_INDEPENDENT_OVERLAP).toBeLessThan(1);
  });
});
