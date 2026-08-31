import { describe, expect, it } from "vitest";

import {
  classifyMissed,
  closedWithoutPosition,
  mayOpenPosition,
  opportunityStateMachine,
  userWasAvailable,
  type OpportunityState,
} from "../opportunity-state-machine";
import { tradeStateMachine } from "../trade-state-machine";

const ALL: readonly OpportunityState[] = [
  "OFFERED",
  "SEEN",
  "USER_CONFIRMED",
  "POSITION_OPENED",
  "REJECTED",
  "INVALIDATED",
  "EXPIRED",
  "CANCELLED",
];

describe("Lebenszyklus einer Gelegenheit", () => {
  it("kennt genau diese acht Zustaende", () => {
    expect(opportunityStateMachine.allStates().sort()).toEqual([...ALL].sort());
  });

  it("laesst nur aus CONFIRMED eine Position entstehen", () => {
    // Die technische Fassung von „MISSED ≠ LOSS" und „USER_REJECTED ≠ LOSS":
    // aus keinem anderen Zustand kann ueberhaupt eine Performance-Zeile werden.
    for (const state of ALL) {
      expect(mayOpenPosition(state)).toBe(state === "USER_CONFIRMED");
    }
    for (const state of ALL) {
      if (state === "USER_CONFIRMED") continue;
      expect(opportunityStateMachine.canTransition(state, "POSITION_OPENED")).toBe(false);
    }
  });

  it("macht abgelehnt, abgelaufen und zurueckgezogen endgueltig", () => {
    for (const state of ["POSITION_OPENED", "REJECTED", "INVALIDATED", "EXPIRED", "CANCELLED"] as const) {
      expect(opportunityStateMachine.isTerminal(state)).toBe(true);
    }
  });

  it("laesst eine Ablehnung nicht nachtraeglich zur Bestaetigung werden", () => {
    expect(() => opportunityStateMachine.assertTransition("REJECTED", "USER_CONFIRMED")).toThrow();
    expect(() => opportunityStateMachine.assertTransition("EXPIRED", "USER_CONFIRMED")).toThrow();
  });

  it("erlaubt der Revalidierung, eine Bestaetigung noch zu entwerten", () => {
    // §67: bestaetigt heisst nicht handelbar. Zwischen Alert und Reaktion kann
    // sich die Lage geaendert haben.
    expect(opportunityStateMachine.canTransition("USER_CONFIRMED", "INVALIDATED")).toBe(true);
  });

  it("erlaubt Ablauf auch nach dem Oeffnen des Alerts", () => {
    expect(opportunityStateMachine.canTransition("SEEN", "EXPIRED")).toBe(true);
  });

  it("trennt Verfuegbarkeit des Nutzers von der Entscheidung", () => {
    // Ein abgelaufener Alert ist ein Erreichbarkeitsproblem, kein Strategiefehler.
    expect(userWasAvailable("EXPIRED")).toBe(false);
    expect(userWasAvailable("CANCELLED")).toBe(false);
    expect(userWasAvailable("REJECTED")).toBe(true);
    expect(userWasAvailable("SEEN")).toBe(true);
  });

  it("zaehlt genau die Endzustaende ohne Position als Forschungsmaterial", () => {
    expect(ALL.filter(closedWithoutPosition).sort()).toEqual([
      "CANCELLED",
      "EXPIRED",
      "INVALIDATED",
      "REJECTED",
    ]);
    expect(closedWithoutPosition("POSITION_OPENED")).toBe(false);
  });

  it("teilt keinen einzigen Zustand mit dem Handelsautomaten", () => {
    // Getrennte Automaten sind Absicht: „hat der Mensch reagiert" und „ist die
    // Transaktion bestaetigt" sind verschiedene Fragen. Ein gemeinsames Enum
    // wuerde Uebergaenge wie SEEN → SUBMITTED erlauben.
    const trade = new Set<string>(tradeStateMachine.allStates());
    for (const state of ALL) expect(trade.has(state)).toBe(false);
  });
});

describe("MISSED ist eine Klassifikation, kein Zustand", () => {
  it("gilt nur fuer abgelaufene Gelegenheiten", () => {
    for (const state of ALL) {
      const missed = classifyMissed({ state, hypotheticalMfe: 5, threshold: 0.25 });
      expect(missed).toBe(state === "EXPIRED");
    }
  });

  it("bleibt ohne Verlaufsdaten aus", () => {
    // Kein Verlauf heisst nicht „nichts verpasst" — es heisst „unbekannt", und
    // unbekannt wird hier nicht optimistisch aufgeloest.
    expect(classifyMissed({ state: "EXPIRED", hypotheticalMfe: null, threshold: 0.25 })).toBe(
      false,
    );
  });

  it("liegt genau auf der Schwelle noch drin", () => {
    expect(classifyMissed({ state: "EXPIRED", hypotheticalMfe: 0.25, threshold: 0.25 })).toBe(true);
    expect(classifyMissed({ state: "EXPIRED", hypotheticalMfe: 0.24, threshold: 0.25 })).toBe(
      false,
    );
  });

  it("nennt eine bewusste Ablehnung niemals verpasst", () => {
    expect(classifyMissed({ state: "REJECTED", hypotheticalMfe: 99, threshold: 0.25 })).toBe(false);
  });
});
