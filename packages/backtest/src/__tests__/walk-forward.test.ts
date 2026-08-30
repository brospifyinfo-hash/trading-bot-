import { describe, expect, it } from "vitest";
import { assertNoOverlapWithin, buildWalkForwardWindows } from "../walk-forward";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const config = {
  from: d("2026-01-01"),
  to: d("2026-07-01"),
  trainingDays: 60,
  validationDays: 15,
  outOfSampleDays: 15,
  stepDays: 15,
};

describe("buildWalkForwardWindows", () => {
  it("baut rollierende Fenster", () => {
    const windows = buildWalkForwardWindows(config);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]!.training.from).toEqual(d("2026-01-01"));
    expect(windows[0]!.training.to).toEqual(d("2026-03-02"));
    expect(windows[0]!.validation.to).toEqual(d("2026-03-17"));
    expect(windows[0]!.outOfSample.to).toEqual(d("2026-04-01"));
  });

  it("haelt die Reihenfolge Training, Validierung, Out-of-Sample ein", () => {
    // Ein Out-of-Sample-Fenster, das ins Training ragt, ist keines mehr — und
    // der Fehler ist im Ergebnis nicht zu sehen.
    for (const window of buildWalkForwardWindows(config)) {
      expect(() => assertNoOverlapWithin(window)).not.toThrow();
      expect(window.training.to.getTime()).toBeLessThanOrEqual(window.validation.from.getTime());
      expect(window.validation.to.getTime()).toBeLessThanOrEqual(window.outOfSample.from.getTime());
    }
  });

  it("rueckt je Schritt um stepDays weiter", () => {
    const windows = buildWalkForwardWindows(config);
    const gap =
      windows[1]!.training.from.getTime() - windows[0]!.training.from.getTime();
    expect(gap / 86_400_000).toBe(config.stepDays);
  });

  it("erzeugt kein verkuerztes letztes Fenster", () => {
    // Ein gekuerztes Out-of-Sample-Fenster saehe wie ein gueltiges Ergebnis aus.
    const windows = buildWalkForwardWindows(config);
    const last = windows[windows.length - 1]!;
    expect(last.outOfSample.to.getTime()).toBeLessThanOrEqual(config.to.getTime());
    for (const window of windows) {
      const days =
        (window.outOfSample.to.getTime() - window.outOfSample.from.getTime()) / 86_400_000;
      expect(days).toBe(config.outOfSampleDays);
    }
  });

  it("wirft, wenn der Zeitraum nicht einmal ein Fenster traegt", () => {
    expect(() => buildWalkForwardWindows({ ...config, to: d("2026-02-01") })).toThrow(RangeError);
  });

  it("wirft bei unsinnigen Fensterlaengen", () => {
    expect(() => buildWalkForwardWindows({ ...config, trainingDays: 0 })).toThrow(RangeError);
    expect(() => buildWalkForwardWindows({ ...config, stepDays: -5 })).toThrow(RangeError);
  });

  it("wirft, wenn der Zeitraum rueckwaerts laeuft", () => {
    expect(() => buildWalkForwardWindows({ ...config, to: d("2025-01-01") })).toThrow(RangeError);
  });
});
