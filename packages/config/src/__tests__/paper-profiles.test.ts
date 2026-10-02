import { describe, expect, it } from "vitest";

import { MAX_MARKET_CAP_DEFAULT_USD, PAPER_STRATEGY_ID, paperCandidate } from "../memecoin-paper";

/**
 * Ein Konto, eine frei waehlbare Schwelle.
 *
 * Die GRENZEN der Schwelle und ihr Lesen aus der Datenbank stehen in
 * `@sae/db` und werden dort geprueft — hier geht es nur darum, was aus einer
 * gueltigen Schwelle wird.
 */
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
    const gates = paperCandidate(50).parameters.entryGates;
    expect(gates.paperLaunchMode).toBe(true);
    expect(gates.paperLaunchMinBuys).not.toBeUndefined();
    expect(gates.paperLaunchMaxAgeSeconds).not.toBeUndefined();
  });
});

/**
 * Die Groessengrenze — und der Fehler, den sie behebt.
 *
 * Der Offensiv-Modus hatte `maxMarketCapUsd` auf eine Billion gesetzt, also
 * faktisch keinen Deckel. Das war eine Fehluebersetzung von „soll nicht so
 * lange abwarten": ein offener Groessendeckel laesst den Bot nicht FRUEHER
 * handeln, sondern das FALSCHE handeln. Wer einen Memecoin-Sniper baut und ihm
 * erlaubt, einen Milliarden-Coin zu kaufen, hat keinen Sniper gebaut.
 */
describe("Groessengrenze", () => {
  it("bleibt im Offensiv-Modus genau so streng wie im vorsichtigen", () => {
    const vorsichtig = paperCandidate(50, "VORSICHTIG", { maxMarketCapUsd: 5_000_000 });
    const offensiv = paperCandidate(50, "OFFENSIV", { maxMarketCapUsd: 5_000_000 });
    expect(offensiv.parameters.entryGates.maxMarketCapUsd).toBe(5_000_000);
    expect(offensiv.parameters.entryGates.maxMarketCapUsd)
      .toBe(vorsichtig.parameters.entryGates.maxMarketCapUsd);
  });

  it.each([1_000_000, 5_000_000, 50_000_000])("nimmt %i als Grenze", (cap) => {
    for (const modus of ["VORSICHTIG", "OFFENSIV"] as const) {
      expect(paperCandidate(50, modus, { maxMarketCapUsd: cap }).parameters.entryGates.maxMarketCapUsd)
        .toBe(cap);
    }
  });

  it("laesst ohne Angabe eine kleine Grenze gelten, nicht keine", () => {
    // Die Voreinstellung muss klein sein. Eine grosszuegige Voreinstellung
    // waere derselbe Fehler, nur leiser.
    expect(paperCandidate(50, "OFFENSIV").parameters.entryGates.maxMarketCapUsd)
      .toBe(MAX_MARKET_CAP_DEFAULT_USD);
    expect(MAX_MARKET_CAP_DEFAULT_USD).toBeLessThanOrEqual(10_000_000);
  });
});
