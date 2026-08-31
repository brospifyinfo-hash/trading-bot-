import { describe, expect, it } from "vitest";

import {
  CandidateChainError,
  VALIDATION_CHAIN,
  advanceCandidate,
  candidateStateMachine,
  isInProgress,
  isPromotable,
  type CandidateState,
  type StrategyCandidate,
} from "../candidates";

const ALL: readonly CandidateState[] = [
  "HYPOTHESIS",
  "BACKTESTED",
  "WALK_FORWARDED",
  "OUT_OF_SAMPLE_TESTED",
  "SHADOW_TRADING",
  "PROMOTED",
  "REJECTED",
  "SHELVED",
];

function candidate(state: CandidateState = "HYPOTHESIS"): StrategyCandidate {
  return {
    candidateId: "cand-1",
    state,
    origin: "FEATURE_ANALYSIS",
    researchBatchId: "batch-1",
    hypothesis: "Tokens mit hoher Akteursstreuung halten laenger.",
    parameters: { minDistinctActors: 40 },
    baseStrategyVersionId: "sv-1",
    createdAt: new Date(Date.UTC(2026, 7, 1)),
    closedReason: null,
  };
}

describe("Pruefkette", () => {
  it("kennt genau diese acht Zustaende", () => {
    expect(candidateStateMachine.allStates().sort()).toEqual([...ALL].sort());
  });

  it("laesst sich nicht abkuerzen", () => {
    // Der ganze Zweck des Automaten: Backtest → Walk Forward → Out-of-Sample →
    // Shadow ist erzwungen, nicht empfohlen.
    expect(() => advanceCandidate(candidate("HYPOTHESIS"), "PROMOTED")).toThrow(
      CandidateChainError,
    );
    expect(() => advanceCandidate(candidate("BACKTESTED"), "SHADOW_TRADING")).toThrow(
      CandidateChainError,
    );
    expect(() => advanceCandidate(candidate("HYPOTHESIS"), "OUT_OF_SAMPLE_TESTED")).toThrow(
      CandidateChainError,
    );
  });

  it("laesst die Kette Stufe fuer Stufe durchlaufen", () => {
    let c = candidate("HYPOTHESIS");
    for (let i = 1; i < VALIDATION_CHAIN.length; i += 1) {
      c = advanceCandidate(c, VALIDATION_CHAIN[i]!);
      expect(c.state).toBe(VALIDATION_CHAIN[i]);
    }
    c = advanceCandidate(c, "PROMOTED");
    expect(c.state).toBe("PROMOTED");
  });

  it("erlaubt Ablehnung auf jeder Stufe", () => {
    // Ablehnung ist die Aufgabe des Systems, kein Fehlschlag.
    for (const state of VALIDATION_CHAIN) {
      expect(candidateStateMachine.canTransition(state, "REJECTED")).toBe(true);
    }
  });

  it("laesst einen abgelehnten Kandidaten nicht zurueckkehren", () => {
    expect(() => advanceCandidate(candidate("REJECTED"), "SHADOW_TRADING")).toThrow();
    expect(candidateStateMachine.isTerminal("REJECTED")).toBe(true);
    expect(candidateStateMachine.isTerminal("SHELVED")).toBe(true);
  });

  it("laesst PROMOTED nur aus dem Shadow Trading erreichen", () => {
    // Die einzige Tuer zur Promotion. Ohne diese Enge waere die Kette eine
    // Empfehlung und keine Bedingung.
    const predecessors = ALL.filter((s) => candidateStateMachine.canTransition(s, "PROMOTED"));
    expect(predecessors).toEqual(["SHADOW_TRADING"]);
  });

  it("bedeutet PROMOTED nicht „aktiv“", () => {
    // Scharfschalten ist ein Vorgang an strategy_versions mit activatedBy.
    expect(isPromotable("PROMOTED")).toBe(true);
    expect(isInProgress("PROMOTED")).toBe(false);
    for (const state of VALIDATION_CHAIN) expect(isPromotable(state)).toBe(false);
  });

  it("haelt den Grund fuer Ablehnung fest", () => {
    const rejected = advanceCandidate(
      candidate("OUT_OF_SAMPLE_TESTED"),
      "REJECTED",
      "Out-of-Sample-Trefferquote unter der unteren Konfidenzgrenze des Champions.",
    );
    expect(rejected.closedReason).toMatch(/Out-of-Sample/);
  });
});
