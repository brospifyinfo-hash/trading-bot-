import { describe, expect, it } from "vitest";

import {
  ALWAYS_ON_STREAMS,
  DEFAULT_SYSTEM_STATE,
  isAlwaysOn,
  streamIsActive,
  usesRealCapital,
  type SystemState,
  type TradingStream,
} from "../streams";

const ALL: readonly TradingStream[] = ["AUTO_PAPER", "MANUAL_PAPER", "LIVE"];

describe("Handelsstroeme", () => {
  it("startet mit ausgeschaltetem Live-Handel", () => {
    // Der einzige vertretbare Default: echtes Geld bewegt sich erst, wenn es
    // jemand ausdruecklich einschaltet.
    expect(DEFAULT_SYSTEM_STATE.liveTradingEnabled).toBe(false);
    expect(streamIsActive("LIVE", DEFAULT_SYSTEM_STATE)).toBe(false);
  });

  it("laesst beide Paper-Stroeme immer laufen", () => {
    const states: SystemState[] = [
      DEFAULT_SYSTEM_STATE,
      { liveTradingEnabled: true, manualAlertsEnabled: true, emergencyStop: false },
      { liveTradingEnabled: false, manualAlertsEnabled: false, emergencyStop: true },
    ];
    for (const state of states) {
      expect(streamIsActive("AUTO_PAPER", state)).toBe(true);
      expect(streamIsActive("MANUAL_PAPER", state)).toBe(true);
    }
  });

  it("haelt beim Notstopp nur das Kapital an, nicht die Beobachtung", () => {
    const stopped: SystemState = {
      liveTradingEnabled: true,
      manualAlertsEnabled: true,
      emergencyStop: true,
    };
    expect(streamIsActive("LIVE", stopped)).toBe(false);
    // Ausgerechnet die Phase, die den Stopp ausgeloest hat, ist die
    // interessanteste — ohne laufende Paper-Stroeme fehlt genau dafuer die
    // Datengrundlage.
    expect(streamIsActive("AUTO_PAPER", stopped)).toBe(true);
    expect(streamIsActive("MANUAL_PAPER", stopped)).toBe(true);
  });

  it("laesst MANUAL_PAPER auch ohne Alerts weiterlaufen", () => {
    const silent: SystemState = {
      liveTradingEnabled: false,
      manualAlertsEnabled: false,
      emergencyStop: false,
    };
    expect(streamIsActive("MANUAL_PAPER", silent)).toBe(true);
  });

  it("kennt genau einen Strom mit echtem Kapital", () => {
    expect(ALL.filter(usesRealCapital)).toEqual(["LIVE"]);
  });

  it("fuehrt die immer laufenden Stroeme als Konstante, nicht als Einstellung", () => {
    // Eine Einstellung, die man setzen kann, wird irgendwann gesetzt.
    expect([...ALWAYS_ON_STREAMS].sort()).toEqual(["AUTO_PAPER", "MANUAL_PAPER"]);
    expect(ALL.filter(isAlwaysOn)).toHaveLength(2);
    expect(isAlwaysOn("LIVE")).toBe(false);
  });
});
