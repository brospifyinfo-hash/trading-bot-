import { describe, expect, it } from "vitest";

import {
  PAPER_ENTRY_SCORE_DEFAULT,
  PAPER_ENTRY_SCORE_MAX,
  PAPER_ENTRY_SCORE_MIN,
  PAPER_ENTRY_SCORE_VAR,
  PAPER_STRATEGY_ID,
  paperCandidate,
  readPaperEntryScore,
} from "../memecoin-paper";

/**
 * Ein Konto, eine frei waehlbare Schwelle.
 *
 * Vorher standen hier drei Profile nebeneinander. Die Tests dazu pruefen jetzt
 * zwei andere Dinge, und beide betreffen Fehler, die im Betrieb teuer waeren:
 *
 * 1. Eine unbrauchbare Einstellung darf NICHT still zur Voreinstellung werden.
 * 2. Die Schwelle muss die Version aendern, sonst wuerden frueher getroffene
 *    Entscheidungen rueckwirkend an einer Regel gemessen, die damals nicht galt.
 */
describe("Einstiegsschwelle lesen", () => {
  it("meldet die Voreinstellung als Voreinstellung, nicht als Wahl", () => {
    expect(readPaperEntryScore({})).toEqual({
      kind: "DEFAULT",
      score: PAPER_ENTRY_SCORE_DEFAULT,
    });
    // Eine leere Variable ist dasselbe wie keine. Sie als 0 zu lesen waere ein
    // Einstieg bei jedem Score.
    expect(readPaperEntryScore({ [PAPER_ENTRY_SCORE_VAR]: "  " }).kind).toBe("DEFAULT");
  });

  it.each([10, 35, 50, 70, PAPER_ENTRY_SCORE_MIN, PAPER_ENTRY_SCORE_MAX])(
    "nimmt %i als gesetzte Wahl",
    (score) => {
      expect(readPaperEntryScore({ [PAPER_ENTRY_SCORE_VAR]: String(score) })).toEqual({
        kind: "SET",
        score,
      });
    },
  );

  it.each([
    ["Text", "ziemlich hoch"],
    ["leere Zahl", "NaN"],
    ["Komma", "35,5"],
    ["Bruch", "35.5"],
    ["zu klein", String(PAPER_ENTRY_SCORE_MIN - 1)],
    ["zu gross", String(PAPER_ENTRY_SCORE_MAX + 1)],
    ["negativ", "-20"],
  ])("faellt bei %s NICHT still auf die Voreinstellung zurueck", (_name, raw) => {
    const gelesen = readPaperEntryScore({ [PAPER_ENTRY_SCORE_VAR]: raw });
    expect(gelesen.kind).toBe("INVALID");
    // Der Kern: kein `score`. Wer hier eine Zahl zurueckgaebe, haette ein
    // System gebaut, das bei 50 handelt, waehrend der Betreiber 20 gesetzt hat.
    expect(gelesen).not.toHaveProperty("score");
  });
});

describe("Kandidat zur Schwelle", () => {
  it("traegt die Schwelle in der Version, nicht nur in den Parametern", () => {
    // Sonst benutzten zwei Laeufe mit verschiedenen Schwellen dieselbe
    // unveraenderliche Version — und `ensurePaperCandidateVersion` wuerde zu
    // Recht mit „Stored candidate version differs" abbrechen.
    expect(paperCandidate(35).version).not.toBe(paperCandidate(50).version);
    expect(paperCandidate(35).version).toContain("35");
  });

  it("bleibt bei jeder Schwelle in derselben Strategie-Familie", () => {
    // Die Kontofuehrung haengt an der Familie. Ein Wechsel hiesse: neues Konto,
    // neuer Barbestand, alte offene Positionen unbeaufsichtigt.
    for (const score of [10, 50, 95]) {
      expect(paperCandidate(score).strategyId).toBe(PAPER_STRATEGY_ID);
    }
  });

  it("laesst die uebrigen Tore unveraendert, wenn die Schwelle sinkt", () => {
    const hoch = paperCandidate(70).parameters.entryGates;
    const tief = paperCandidate(10).parameters.entryGates;
    expect(tief.minFinalScore).toBe(10);
    expect(hoch.minFinalScore).toBe(70);
    // Eine niedrigere Einstiegsschwelle darf nicht heimlich „weniger
    // Sicherheitspruefung" bedeuten.
    for (const feld of [
      "minSecurityScore",
      "minMomentumScore",
      "minLiquidityUsd",
      "maxTop10HolderSharePct",
      "minDataCompleteness",
    ] as const) {
      expect(tief[feld]).toBe(hoch[feld]);
    }
  });

  it("nennt seine Launch-Schwellen selbst", () => {
    // Vorher standen sie als `?? 3` und `?? 60` an der Benutzungsstelle — eine
    // zweite, unsichtbare Konfiguration (§139).
    const gates = paperCandidate(PAPER_ENTRY_SCORE_DEFAULT).parameters.entryGates;
    expect(gates.paperLaunchMode).toBe(true);
    expect(gates.paperLaunchMinBuys).not.toBeUndefined();
    expect(gates.paperLaunchMaxAgeSeconds).not.toBeUndefined();
  });
});
