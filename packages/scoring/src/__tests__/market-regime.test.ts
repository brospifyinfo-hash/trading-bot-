import { describe, expect, it } from "vitest";

import {
  BackfillRejectedError,
  DEFAULT_HYSTERESIS,
  RegimeTimeline,
  assessRegime,
  type RegimeInputs,
} from "../market-regime";

const T0 = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const riskOn: RegimeInputs = {
  breadth: 0.75,
  medianReturn: 0.12,
  newListingRate: 1.6,
  stopRate: 0.1,
};
const riskOff: RegimeInputs = {
  breadth: 0.2,
  medianReturn: -0.15,
  newListingRate: 0.5,
  stopRate: 0.8,
};

describe("Regime-Einschaetzung", () => {
  it("erkennt beide Extreme", () => {
    expect(assessRegime(riskOn).regime).toBe("RISK_ON");
    expect(assessRegime(riskOff).regime).toBe("RISK_OFF");
  });

  it("bleibt bei zu wenigen Indikatoren UNKNOWN, statt zu raten", () => {
    const thin = assessRegime({
      breadth: 0.75,
      medianReturn: null,
      newListingRate: null,
      stopRate: null,
    });

    expect(thin.regime).toBe("UNKNOWN");
    expect(thin.available).toEqual(["BREADTH"]);
    expect(thin.missing).toHaveLength(3);
    expect(thin.note).toMatch(/Indikatoren vorhanden/);
  });

  it("faellt bei Uneinigkeit auf NEUTRAL, ohne Stichentscheid", () => {
    // Ein Stichentscheid waere eine Gewichtung, die sich spaeter passend
    // machen laesst.
    const split = assessRegime({
      breadth: 0.75,
      medianReturn: -0.15,
      newListingRate: 1.6,
      stopRate: 0.8,
    });
    expect(split.regime).toBe("NEUTRAL");
  });

  it("liest eine hohe Stop-Quote als Risk-Off", () => {
    const votes = assessRegime(riskOff).votes;
    expect(votes.STOP_RATE).toBe("RISK_OFF");
    expect(assessRegime(riskOn).votes.STOP_RATE).toBe("RISK_ON");
  });
});

describe("Regime-Verlauf", () => {
  it("wechselt nicht bei einer einzelnen abweichenden Messung", () => {
    const timeline = new RegimeTimeline();
    expect(timeline.observe(assessRegime(riskOn), at(0))).toBe("RISK_ON");

    // Eine Messung reicht nicht — sonst flattert das Label und jede spaetere
    // Auswertung nach Regime mischt Phasen, die nur Rauschen trennt.
    expect(timeline.observe(assessRegime(riskOff), at(20))).toBe("RISK_ON");
    expect(timeline.observe(assessRegime(riskOff), at(40))).toBe("RISK_ON");
    expect(timeline.observe(assessRegime(riskOff), at(60))).toBe("RISK_OFF");
    expect(timeline.entries).toHaveLength(2);
  });

  it("setzt die Zaehlung zurueck, wenn die Abweichung nicht anhaelt", () => {
    const timeline = new RegimeTimeline();
    timeline.observe(assessRegime(riskOn), at(0));
    timeline.observe(assessRegime(riskOff), at(20));
    timeline.observe(assessRegime(riskOff), at(40));
    // Dazwischen wieder das alte Regime: die zwei Bestaetigungen verfallen.
    timeline.observe(assessRegime(riskOn), at(60));
    expect(timeline.observe(assessRegime(riskOff), at(80))).toBe("RISK_ON");
  });

  it("wechselt nicht vor Ablauf der Mindestverweildauer", () => {
    const timeline = new RegimeTimeline({ confirmationsToSwitch: 1, minDwellSeconds: 900 });
    timeline.observe(assessRegime(riskOn), at(0));
    expect(timeline.observe(assessRegime(riskOff), at(5))).toBe("RISK_ON");
    expect(timeline.observe(assessRegime(riskOff), at(20))).toBe("RISK_OFF");
  });

  it("weist ein rueckwirkend eingetragenes Regime zurueck", () => {
    // I-3: ein nachtraeglich vergebenes Label ist Look-Ahead, der wie eine
    // Erkenntnis aussieht.
    const timeline = new RegimeTimeline();
    timeline.observe(assessRegime(riskOn), at(60));
    expect(() => timeline.observe(assessRegime(riskOff), at(30))).toThrow(BackfillRejectedError);
  });

  it("kennt vor dem ersten Eintrag kein Regime", () => {
    const timeline = new RegimeTimeline();
    timeline.observe(assessRegime(riskOn), at(60));
    // Rueckwaerts extrapoliert waere genau der Look-Ahead aus I-3.
    expect(timeline.regimeAt(at(30))).toBe("UNKNOWN");
    expect(timeline.regimeAt(at(60))).toBe("RISK_ON");
    expect(timeline.regimeAt(at(600))).toBe("RISK_ON");
  });

  it("bietet keine Methode zum Aendern bestehender Eintraege", () => {
    const timeline = new RegimeTimeline();
    timeline.observe(assessRegime(riskOn), at(0));
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(timeline));
    expect(methods).not.toContain("update");
    expect(methods).not.toContain("backfill");
    expect(DEFAULT_HYSTERESIS.confirmationsToSwitch).toBeGreaterThan(1);
  });
});
