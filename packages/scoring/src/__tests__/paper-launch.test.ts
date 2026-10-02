import { expect, it } from "vitest";
import { computePaperLaunchScores } from "../paper-launch";
import { gone, healthyToken } from "./fixtures";

it("computes a launch score without inventing historical momentum", () => {
  const v = healthyToken();
  const launch = { ...v, momentum: { ...v.momentum, priceChange5m: gone<number>(), priceChange1h: gone<number>(), volumeAcceleration: gone<number>() } };
  const result = computePaperLaunchScores(launch);
  expect(result.finalScore).toBeGreaterThan(50);
  expect(result.dataCompleteness).toBe(1);
  expect(result.scoreEngineVersion).toBe("paper-launch-1.0.0");
  expect(result.missingFields.some((f) => f.field === "momentum.priceChange5m")).toBe(true);
  expect(launch.momentum.priceChange5m.kind).toBe("MISSING");
});

it("cannot form a score with missing authority or exit data", () => {
  const v = healthyToken();
  for (const launch of [
    { ...v, security: { ...v.security, mintAuthorityActive: gone<boolean>() } },
    { ...v, execution: { ...v.execution, exitCapacityRatio: gone<number>() } },
  ]) {
    const result = computePaperLaunchScores(launch);
    expect(result.finalScore).toBeNull();

  }
});

/**
 * Warum eine Schwelle von 10 nichts bewirkt.
 *
 * Der Betreiber hat die Einstiegsschwelle 24 Stunden auf 10 gestellt — also
 * praktisch „kauf alles" — und es wurde kein einziges Mal gekauft. Der Grund
 * steht in der Zeile `finalScore: complete && ... ? score(...) : null` weiter
 * oben, und er ist unabhaengig von jeder Schwelle:
 *
 * Fehlt EIN einziges der dreizehn Pflichtfelder, ist `finalScore` NICHT eine
 * niedrige Zahl, sondern `null`. Die Entscheidungsmaschine prueft `null`
 * ZUERST und antwortet mit `REJECT / DATA_INCOMPLETE` — die Schwelle wird
 * danach nie erreicht, weil der Vergleich nie stattfindet.
 *
 * Eine Schwelle von 10 und eine von 95 fuehren damit zum identischen
 * Ergebnis. Der Regler im Dashboard konnte an diesem Zustand nichts aendern,
 * und nichts sagte das.
 *
 * Dieser Test haelt beides fest: dass die Zahl `null` wird, und dass sie bei
 * jeder Schwelle dasselbe bedeutet.
 */
it("macht aus einem fehlenden Pflichtfeld keinen niedrigen Score, sondern keinen", () => {
  const v = healthyToken();
  // Genau das Bild aus dem Betrieb: alle Marktfelder da, die drei
  // Ausfuehrungsfelder fehlen, weil die Kette auf eine Quelle zurueckgefallen
  // ist, die keine Route rechnet (DECISIONS §140).
  const ohneAusfuehrung = {
    ...v,
    execution: {
      expectedCostBps: gone<number>(),
      exitCapacityRatio: gone<number>(),
      priceImpactBps: gone<number>(),
    },
  };
  const result = computePaperLaunchScores(ohneAusfuehrung);

  expect(result.finalScore).toBeNull();
  // Und die Vollstaendigkeit liegt bei 10 von 13 — nicht bei 0. Die Daten
  // sehen also reichhaltig aus, und trotzdem ist keine Entscheidung moeglich.
  expect(result.dataCompleteness).toBeCloseTo(10 / 13, 5);

  // Mit vollstaendigen Daten entsteht sehr wohl ein Score, und er liegt weit
  // ueber 10. Es fehlt also nicht an der Qualitaet der Coins.
  expect(computePaperLaunchScores(v).finalScore).toBeGreaterThan(10);
});
