import { describe, expect, it } from "vitest";

import {
  LATENCY_STAGE_ORDER,
  NonMonotonicChainError,
  actualResponseMs,
  buildLatencyChain,
  segmentMs,
  summarizeLatency,
  type StageTimestamps,
} from "../latency-chain";

const T0 = new Date(Date.UTC(2026, 7, 1, 12, 0, 0));
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const manualChain: StageTimestamps = {
  OBSERVED: at(0),
  INGESTED: at(300),
  DECIDED: at(500),
  ALERTED: at(700),
  SEEN: at(45_000),
  RESPONDED: at(62_000),
  QUOTED: at(62_400),
  SUBMITTED: at(62_800),
  CONFIRMED: at(64_500),
};

const autoChain: StageTimestamps = {
  OBSERVED: at(0),
  INGESTED: at(300),
  DECIDED: at(500),
  QUOTED: at(900),
  SUBMITTED: at(1_300),
  CONFIRMED: at(3_100),
};

describe("Zeitstempelkette", () => {
  it("misst jeden Abschnitt einzeln", () => {
    const chain = buildLatencyChain(manualChain);
    expect(chain.segments).toHaveLength(LATENCY_STAGE_ORDER.length - 1);
    expect(segmentMs(chain, "OBSERVED", "INGESTED")).toBe(300);
    expect(segmentMs(chain, "SUBMITTED", "CONFIRMED")).toBe(1_700);
  });

  it("trennt menschliche von systembedingter Zeit", () => {
    const chain = buildLatencyChain(manualChain);
    // 61,3 Sekunden davon hat der Mensch gebraucht. Eine Gesamtzahl von 64,5 s
    // wuerde eine Optimierung anleiten, die nichts bringt.
    expect(chain.humanMs).toBe(61_300);
    expect(chain.totalMs).toBe(64_500);
    expect(chain.systemMs!).toBeLessThan(4_000);
  });

  it("kennt im Auto-Strom keine menschliche Zeit", () => {
    const chain = buildLatencyChain(autoChain);
    expect(chain.humanMs).toBeNull();
    expect(chain.missingStages).toEqual(["ALERTED", "SEEN", "RESPONDED"]);
  });

  it("markiert uebersprungene Stufen, statt sie zu verschweigen", () => {
    const chain = buildLatencyChain(autoChain);
    const decidedToQuoted = chain.segments.find((s) => s.from === "DECIDED")!;

    // Ohne Markierung saehe dieser Abschnitt spaeter aus wie ein
    // DECIDED→ALERTED, das zufaellig sehr lang war.
    expect(decidedToQuoted.to).toBe("QUOTED");
    expect(decidedToQuoted.skippedStages).toEqual(["ALERTED", "SEEN", "RESPONDED"]);
  });

  it("wirft bei rueckwaerts laufender Kette, statt auf null zu deckeln", () => {
    // Auseinanderlaufende Uhren erzeugen sonst negative Teilzeiten, die sich in
    // einem Mittelwert gegenseitig aufheben.
    expect(() =>
      buildLatencyChain({ ...manualChain, RESPONDED: at(40_000) }),
    ).toThrow(NonMonotonicChainError);
  });

  it("kommt mit einer einzelnen Stufe zurecht", () => {
    const chain = buildLatencyChain({ OBSERVED: at(0) });
    expect(chain.totalMs).toBeNull();
    expect(chain.segments).toEqual([]);
    expect(chain.systemMs).toBeNull();
  });
});

describe("Zusammenfassung", () => {
  it("liefert Perzentile und ausdruecklich keinen Mittelwert", () => {
    const values = [...Array.from({ length: 95 }, () => 400), ...Array.from({ length: 5 }, () => 4_000)];
    const summary = summarizeLatency(values);

    expect(summary.p50).toBe(400);
    expect(summary.max).toBe(4_000);
    // Der Mittelwert laege bei 580 ms und verschwiege, dass jeder zwanzigste
    // Fill vier Sekunden braucht.
    expect(Object.keys(summary)).not.toContain("mean");
    expect(summary.note).toMatch(/kein Mittelwert/);
  });

  it("erfindet ohne Messungen nichts", () => {
    const summary = summarizeLatency([]);
    expect(summary.p50).toBeNull();
    expect(summary.max).toBeNull();
  });
});

describe("Reaktionszeit fuer die Manual-Simulation", () => {
  it("nimmt die tatsaechliche Zeit dieser Gelegenheit", () => {
    // I-9: mit einem Median simuliert man einen Nutzer, den es nicht gibt.
    expect(actualResponseMs(buildLatencyChain(manualChain))).toBe(61_300);
  });

  it("liefert ohne Reaktion keinen Ersatzwert", () => {
    const noResponse = buildLatencyChain({
      OBSERVED: at(0),
      DECIDED: at(500),
      ALERTED: at(700),
    });
    expect(actualResponseMs(noResponse)).toBeNull();
  });
});
