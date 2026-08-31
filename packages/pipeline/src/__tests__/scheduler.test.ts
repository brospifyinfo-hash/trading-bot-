import { describe, expect, it } from "vitest";

import {
  DEFAULT_CADENCES,
  afterRun,
  alwaysRunningCadences,
  planTick,
  type CadenceId,
  type CadenceState,
} from "../scheduler";

const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function states(entries: readonly CadenceState[]): Map<CadenceId, CadenceState> {
  return new Map(entries.map((e) => [e.id, e]));
}

function state(
  id: CadenceId,
  lastRunAt: Date | null,
  consecutiveFailures = 0,
): CadenceState {
  return { id, lastRunAt, lastOutcome: consecutiveFailures > 0 ? "FAILED" : "OK", consecutiveFailures };
}

describe("Ohne Marktdaten", () => {
  it("laesst nur die Takte laufen, die keine brauchen", () => {
    const plan = planTick({
      cadences: DEFAULT_CADENCES,
      states: new Map(),
      now: T0,
      marketDataAvailable: false,
      remainingRequests: null,
    });

    expect(plan.toRun).toContain("PROVIDER_HEALTH");
    expect(plan.toRun).not.toContain("FAST_DISCOVERY");
    expect(plan.toRun).not.toContain("MARKET_UPDATE");
    expect(plan.waitingForMarketData).toContain("MARKET_UPDATE");
  });

  it("haelt die Provider-Pruefung als Wiederanlaufmechanismus offen", () => {
    // Der einzige Takt, der auch im blockierten Zustand weiterlaeuft — sonst
    // merkt niemand, wenn eine Quelle zurueckkommt.
    expect(alwaysRunningCadences()).toContain("PROVIDER_HEALTH");
  });

  it("startet die Pipeline, sobald eine Quelle da ist", () => {
    const blocked = planTick({
      cadences: DEFAULT_CADENCES,
      states: new Map(),
      now: T0,
      marketDataAvailable: false,
      remainingRequests: null,
    });
    const connected = planTick({
      cadences: DEFAULT_CADENCES,
      states: new Map(),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: null,
    });

    expect(blocked.waitingForMarketData.length).toBeGreaterThan(0);
    expect(connected.waitingForMarketData).toEqual([]);
    for (const id of ["FAST_DISCOVERY", "MARKET_UPDATE", "PAPER_MONITOR"] as const) {
      expect(connected.toRun).toContain(id);
    }
  });
});

describe("Takte", () => {
  it("laesst einen noch nicht faelligen Takt aus", () => {
    const plan = planTick({
      cadences: DEFAULT_CADENCES.filter((c) => c.id === "FAST_DISCOVERY"),
      states: states([state("FAST_DISCOVERY", at(-5_000))]),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: null,
    });

    expect(plan.toRun).toEqual([]);
    expect(plan.decisions[0]).toMatchObject({ kind: "NOT_DUE" });
  });

  it("holt einen langen Ausfall nicht nach", () => {
    // Eine Stunde ausgefallen, 30-Sekunden-Takt: einmal laufen, nicht 120-mal.
    const plan = planTick({
      cadences: DEFAULT_CADENCES.filter((c) => c.id === "FAST_DISCOVERY"),
      states: states([state("FAST_DISCOVERY", at(-3_600_000))]),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: null,
    });

    expect(plan.toRun).toEqual(["FAST_DISCOVERY"]);
    const next = afterRun(undefined, "FAST_DISCOVERY", T0, "OK");
    expect(next.lastRunAt).toBe(T0);
  });

  it("verlangsamt einen Takt, der wiederholt scheitert", () => {
    const failing = planTick({
      cadences: DEFAULT_CADENCES.filter((c) => c.id === "MARKET_UPDATE"),
      states: states([state("MARKET_UPDATE", at(-25_000), 3)]),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: null,
    });
    // 20 s Takt, dreimal gescheitert: der Abstand ist gewachsen.
    expect(failing.toRun).toEqual([]);
  });

  it("setzt die Verlangsamung nach einem Erfolg zurueck", () => {
    const recovered = afterRun(state("MARKET_UPDATE", at(-1_000), 5), "MARKET_UPDATE", T0, "OK");
    expect(recovered.consecutiveFailures).toBe(0);
  });
});

describe("Rate Limits", () => {
  it("verschiebt einen Takt, der nicht ins Budget passt", () => {
    const plan = planTick({
      cadences: DEFAULT_CADENCES.filter((c) => c.id === "MARKET_UPDATE"),
      states: new Map(),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: 5,
    });

    // Verschoben statt gedrosselt: gedrosselt hiesse, die Anfragen fehlen
    // spaeter der Positionsueberwachung.
    expect(plan.toRun).toEqual([]);
    expect(plan.decisions[0]).toMatchObject({ kind: "DEFERRED_BUDGET", needed: 20 });
  });

  it("bedient bei knappem Budget den dringenderen Takt zuerst", () => {
    const plan = planTick({
      cadences: DEFAULT_CADENCES.filter(
        (c) => c.id === "POSITION_MONITOR" || c.id === "MARKET_UPDATE",
      ),
      states: new Map(),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: 12,
    });

    // Positionsueberwachung hat den kuerzeren Takt und geht vor.
    expect(plan.toRun).toEqual(["POSITION_MONITOR"]);
    expect(plan.plannedRequests).toBe(10);
  });

  it("laeuft ohne bekanntes Budget normal weiter", () => {
    const plan = planTick({
      cadences: DEFAULT_CADENCES,
      states: new Map(),
      now: T0,
      marketDataAvailable: true,
      remainingRequests: null,
    });
    expect(plan.toRun.length).toBe(DEFAULT_CADENCES.length);
  });
});

describe("Voreinstellungen", () => {
  it("gibt der Positionsueberwachung den kuerzesten Takt", () => {
    const byId = new Map(DEFAULT_CADENCES.map((c) => [c.id, c]));
    expect(byId.get("POSITION_MONITOR")!.intervalMs).toBeLessThan(
      byId.get("FAST_DISCOVERY")!.intervalMs,
    );
    expect(byId.get("RESEARCH_BATCH")!.intervalMs).toBeGreaterThan(
      byId.get("STRATEGY_HEALTH")!.intervalMs,
    );
  });

  it("laesst die Paper-Ueberwachung unabhaengig vom Live-Handel laufen", () => {
    const paper = DEFAULT_CADENCES.find((c) => c.id === "PAPER_MONITOR")!;
    expect(paper.requiresMarketData).toBe(true);
    expect(paper.description).toMatch(/unabhaengig vom Live-Handel/);
  });

  it("laesst den Ablauf von Gelegenheiten ohne Marktdaten laufen", () => {
    // I-11: der Uebergang nach EXPIRED muss von der Zeit kommen.
    const expiry = DEFAULT_CADENCES.find((c) => c.id === "OPPORTUNITY_EXPIRY")!;
    expect(expiry.requiresMarketData).toBe(false);
  });
});
