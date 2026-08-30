import { describe, expect, it } from "vitest";
import {
  dataCompleteness,
  isMissing,
  isPresent,
  isStale,
  mapObservation,
  missing,
  observed,
  providerId,
  requireValue,
} from "../observation";

const SRC = providerId("test-provider");
const T0 = new Date("2026-08-30T12:00:00Z");

describe("Observation", () => {
  it("haelt Wert, Quelle und Beobachtungszeitpunkt zusammen", () => {
    const o = observed(42, SRC, T0, { confidence: 0.8 });
    expect(o.value).toBe(42);
    expect(o.source).toBe(SRC);
    expect(o.observedAt).toEqual(T0);
    expect(o.confidence).toBe(0.8);
  });

  it("lehnt eine Konfidenz ausserhalb von [0,1] ab", () => {
    expect(() => observed(1, SRC, T0, { confidence: 1.2 })).toThrow(RangeError);
  });

  it("unterscheidet vorhanden von fehlend", () => {
    expect(isPresent(observed(1, SRC, T0))).toBe(true);
    expect(isMissing(missing("PROVIDER_DOWN", T0))).toBe(true);
  });

  it("laesst MISSING durch mapObservation unveraendert durch", () => {
    const m = missing("NO_DATA_FOR_TOKEN", T0);
    const mapped = mapObservation(m, (v: number) => v * 2);
    expect(mapped).toBe(m);
  });
});

describe("requireValue", () => {
  it("gibt den Wert zurueck, wenn er vorhanden ist", () => {
    expect(requireValue(observed(7, SRC, T0), "Testkontext")).toBe(7);
  });

  it("wirft mit Kontext und Grund, wenn der Wert fehlt", () => {
    expect(() => requireValue(missing("PROVIDER_TIMEOUT", T0), "Liquiditaet")).toThrow(
      /Liquiditaet.*PROVIDER_TIMEOUT/,
    );
  });
});

describe("isStale", () => {
  it("wertet einen fehlenden Wert immer als veraltet", () => {
    // Wichtig: fehlende Daten duerfen nie als "frisch genug" durchgehen.
    expect(isStale(missing("PROVIDER_DOWN", T0), T0, 60_000)).toBe(true);
  });

  it("misst das Alter gegen observedAt", () => {
    const o = observed(1, SRC, T0);
    expect(isStale(o, new Date(T0.getTime() + 30_000), 60_000)).toBe(false);
    expect(isStale(o, new Date(T0.getTime() + 61_000), 60_000)).toBe(true);
  });
});

describe("dataCompleteness", () => {
  it("liefert den Anteil vorhandener Inputs", () => {
    const inputs = [
      observed(1, SRC, T0),
      observed(2, SRC, T0),
      missing("PROVIDER_DOWN", T0),
      missing("NO_DATA_FOR_TOKEN", T0),
    ];
    expect(dataCompleteness(inputs)).toBe(0.5);
  });

  it("liefert 0 fuer eine leere Eingabe statt 1", () => {
    // Keine Inputs bedeutet keine Grundlage — nicht "alles vollstaendig".
    expect(dataCompleteness([])).toBe(0);
  });
});
