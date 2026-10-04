import { describe, expect, it } from "vitest";

import { MAX_MARKET_CAP_DEFAULT_USD, MEMECOIN_PAPER_CANDIDATE, PAPER_STRATEGY_ID, paperCandidate, parameterFingerprint } from "../memecoin-paper";

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

/**
 * Der Versionsname MUSS jede Parameteraenderung mitnehmen.
 *
 * Das ist die Regel, deren Verletzung 4.657 `PAPER_SNIPER`-Auftraege
 * umgebracht hat — vom 2026-10-01 bis ununterbrochen, immer mit dem Satz
 * „Stored candidate version differs or is retired". Die Erklaerung dafuer
 * stand direkt daneben: `ensurePaperCandidateVersion` verlangt, dass ein
 * Name genau einen Parametersatz bezeichnet, und `maxMarketCapUsd` war ein
 * Parameter, der nie im Namen stand.
 *
 * Der Test oben prueft das seit §139 — aber nur fuer die Schwelle. Als Modus
 * und Groessengrenze dazukamen, hat ihn niemand erweitert. Deshalb prueft es
 * jetzt eine Schleife ueber ALLE Eingaben und nicht mehr ein Beispiel.
 */
describe("Versionsname und Parameter", () => {
  const eingaben = [
    { score: 10, mode: "VORSICHTIG" as const, cap: 5_000_000 },
    { score: 10, mode: "OFFENSIV" as const, cap: 5_000_000 },
    { score: 50, mode: "VORSICHTIG" as const, cap: 5_000_000 },
    { score: 50, mode: "OFFENSIV" as const, cap: 5_000_000 },
    // Nur die Groessengrenze unterscheidet diese von der ersten Zeile. Genau
    // diese Aenderung war der Ausloeser, und genau sie stand nicht im Namen.
    { score: 10, mode: "VORSICHTIG" as const, cap: 1_000_000 },
    { score: 10, mode: "OFFENSIV" as const, cap: 50_000_000 },
  ];

  it("gibt jedem Parametersatz einen eigenen Namen", () => {
    const namen = eingaben.map(
      (e) => paperCandidate(e.score, e.mode, { maxMarketCapUsd: e.cap }).version,
    );
    expect(new Set(namen).size).toBe(eingaben.length);
  });

  it("gibt gleichen Eingaben denselben Namen — sonst entstuende bei jedem Lauf eine Version", () => {
    for (const e of eingaben) {
      const a = paperCandidate(e.score, e.mode, { maxMarketCapUsd: e.cap });
      const b = paperCandidate(e.score, e.mode, { maxMarketCapUsd: e.cap });
      expect(a.version).toBe(b.version);
      expect(a.parameters).toEqual(b.parameters);
    }
  });

  it("bleibt lesbar: Schwelle und Modus stehen im Namen", () => {
    // Der Fingerabdruck ersetzt die lesbaren Teile nicht, er ergaenzt sie.
    // Sonst waere im Nachhinein an einer Position nicht ablesbar, wogegen sie
    // gemessen wurde.
    expect(paperCandidate(35, "OFFENSIV").version).toContain("s35");
    expect(paperCandidate(35, "OFFENSIV").version).toContain("offensiv");
    expect(paperCandidate(35, "VORSICHTIG").version).not.toContain("offensiv");
  });

  it("aendert den Namen, wenn sich IRGENDEIN Parameter aendert", () => {
    // Die allgemeine Form der Regel, unabhaengig davon, welches Feld es ist:
    // der Name haengt am Inhalt, nicht an der Pflege durch den Autor.
    const basis = paperCandidate(50, "VORSICHTIG", { maxMarketCapUsd: 5_000_000 });
    const anders = parameterFingerprint({
      ...basis.parameters,
      entryGates: { ...basis.parameters.entryGates, maxTop10HolderSharePct: 42 },
    });
    expect(basis.version).not.toContain(anders);
  });

  it("haengt nicht an der Reihenfolge der Schluessel", () => {
    // Die Parameter entstehen aus mehreren Spreads. Haenge der Abdruck an der
    // Schluesselreihenfolge, wuerde ein Umstellen im Code eine neue Version
    // erfinden, obwohl sich nichts geaendert hat.
    const a = parameterFingerprint({ x: 1, y: { b: 2, a: 3 } });
    const b = parameterFingerprint({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it("unterscheidet Werte, die als Text gleich aussehen", () => {
    expect(parameterFingerprint({ a: 1 })).not.toBe(parameterFingerprint({ a: "1" }));
    expect(parameterFingerprint({ a: null })).not.toBe(parameterFingerprint({ a: undefined }));
    expect(parameterFingerprint({ a: 0 })).not.toBe(parameterFingerprint({ a: false }));
  });
});

/**
 * Die Restfalle: der Basis-Kandidat pflegt seinen Namen weiter von Hand.
 *
 * `MEMECOIN_PAPER_CANDIDATE.version` ist fest `1.0.0`. Wer seine Parameter
 * aendert, ohne diese Zahl anzufassen, baut genau den Fehler wieder, der 4.657
 * Auftraege gekostet hat — nur an der Stelle, die `ensurePaperCandidateVersion`
 * als Voreinstellung benutzt.
 *
 * Eine eingefrorene Konstante umzubauen waere hier die groessere Aenderung.
 * Stattdessen haelt dieser Abdruck sie fest: aendert jemand irgendein Feld,
 * schlaegt der Test fehl und sagt, was zu tun ist. Aus einer Tretmine wird ein
 * roter Test an der richtigen Stelle.
 *
 * **Wenn dieser Test fehlschlaegt:** Parameter bewusst geaendert? Dann
 * `version` auf `1.1.0` (oder weiter) heben UND den Abdruck hier ersetzen.
 * Niemals nur den Abdruck ersetzen — dann zeigen zwei verschiedene
 * Parametersaetze auf denselben Namen, und der Worker stirbt wieder.
 */
it("haelt die Parameter des Basis-Kandidaten an seiner Version fest", () => {
  expect(MEMECOIN_PAPER_CANDIDATE.version).toBe("1.0.0");
  expect(parameterFingerprint(MEMECOIN_PAPER_CANDIDATE.parameters)).toBe("b44e5bebc1935fdd");
});
