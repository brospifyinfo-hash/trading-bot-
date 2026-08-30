import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../errors";
import {
  blocksNewEntryOnMint,
  hasCapitalAtRisk,
  needsReconciliation,
  tradeStateMachine as m,
  type TradeState,
} from "../trade-state-machine";

describe("Trade-State-Machine", () => {
  it("erlaubt den regulaeren Pfad bis zur geschlossenen Position", () => {
    const path: TradeState[] = [
      "INTENT_CREATED",
      "PRE_TRADE_VALIDATION",
      "QUOTED",
      "SIGNING",
      "SUBMITTED",
      "CONFIRMED",
      "OPEN",
      "PARTIALLY_CLOSED",
      "CLOSING",
      "CLOSED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(m.canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("wirft bei einem unzulaessigen Uebergang", () => {
    expect(() => m.assertTransition("INTENT_CREATED", "OPEN")).toThrow(IllegalTransitionError);
    expect(() => m.assertTransition("CLOSED", "OPEN")).toThrow(IllegalTransitionError);
  });

  describe("UNKNOWN", () => {
    it("kann nur nach RECONCILING fuehren", () => {
      expect(m.nextStates("UNKNOWN")).toEqual(["RECONCILING"]);
    });

    it("ist nicht direkt nach FAILED aufloesbar", () => {
      // Der entscheidende Test: eine gesendete, aber unbestaetigte Transaktion
      // darf nie als fehlgeschlagen gelten — sonst kauft das System doppelt.
      expect(m.canTransition("UNKNOWN", "FAILED")).toBe(false);
      expect(m.canTransition("UNKNOWN", "CONFIRMED")).toBe(false);
    });

    it("wird erst durch RECONCILING aufgeloest", () => {
      expect(m.canTransition("RECONCILING", "CONFIRMED")).toBe(true);
      expect(m.canTransition("RECONCILING", "FAILED")).toBe(true);
    });

    it("blockiert weitere Einstiege auf demselben Mint", () => {
      expect(blocksNewEntryOnMint("UNKNOWN")).toBe(true);
      expect(blocksNewEntryOnMint("RECONCILING")).toBe(true);
      expect(needsReconciliation("UNKNOWN")).toBe(true);
    });
  });

  it("kennt SUBMITTED als einzige Quelle von UNKNOWN im Einstiegspfad", () => {
    const sources = m.allStates().filter((s) => m.canTransition(s, "UNKNOWN"));
    expect(sources.sort()).toEqual(["CLOSING", "SUBMITTED"]);
  });

  it("markiert Abbruch- und Endzustaende als terminal", () => {
    expect(m.terminalStates().sort()).toEqual([
      "ABORTED_EXPIRED",
      "ABORTED_POLICY",
      "ABORTED_STALE",
      "CLOSED",
      "FAILED",
      "SIGN_REJECTED",
    ]);
  });

  it("gibt Kapital in Endzustaenden frei, nicht vorher", () => {
    expect(hasCapitalAtRisk("OPEN")).toBe(true);
    expect(hasCapitalAtRisk("PARTIALLY_CLOSED")).toBe(true);
    expect(hasCapitalAtRisk("CLOSED")).toBe(false);
    expect(hasCapitalAtRisk("ABORTED_POLICY")).toBe(false);
  });

  it("erreicht jeden Zustand ausser dem Startzustand von irgendwoher", () => {
    // Ein unerreichbarer Zustand waere toter Code in einer Maschine, die
    // Kapitalfluss steuert.
    for (const state of m.allStates()) {
      if (state === "INTENT_CREATED") continue;
      const reachable = m.allStates().some((from) => from !== state && m.canTransition(from, state));
      expect({ state, reachable }).toEqual({ state, reachable: true });
    }
  });
});
