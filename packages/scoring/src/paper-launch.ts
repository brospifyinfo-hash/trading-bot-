import { isPresent, score, type Maybe } from "@sae/core";
import { collectMissing, type FeatureVector } from "./features";
import { computeScores, type ScoringResult } from "./v1/engine";
import { isScored, notComputable, scored } from "./sub-score";

/** Paper-only launch model. No fabricated price history and no claim of edge.
 * Transaction counts measure activity, not distinct wallets or price momentum.
 * All required launch inputs must be present; other missing data stays visible.
 */
export interface PaperLaunchOptions {
  /**
   * Bildet einen Score auch aus Teildaten.
   *
   * Ohne diese Einstellung ist der Launch-Bewerter alles-oder-nichts: fehlt
   * EIN einziges der dreizehn Pflichtfelder, ist `finalScore` nicht niedrig,
   * sondern `null` — und `null` wird vor jeder Schwelle geprueft. Eine
   * Einstiegsschwelle von 10 hat damit dieselbe Wirkung wie eine von 95,
   * naemlich keine (DECISIONS §144).
   *
   * Mit der Einstellung wird gerechnet, was bekannt ist: die vorhandenen
   * Teilbewertungen werden auf ihr abgedecktes Gewicht normiert — dasselbe
   * Verfahren, das der Standard-Bewerter seit immer benutzt (`v1/engine.ts`).
   * Es wird KEIN Wert erfunden; was fehlt, bleibt in `missingFields` und
   * `notComputable` sichtbar, und `weightCoverage` sagt, auf wie viel
   * Grundlage die Zahl steht.
   *
   * Verlangt bleibt der PREIS. Ohne Einstiegspreis gaebe es keine
   * Papier-Position, sondern eine erfundene — das ist keine gelockerte Regel,
   * sondern Arithmetik.
   */
  readonly partial?: boolean;
}

export function computePaperLaunchScores(
  v: FeatureVector,
  options: PaperLaunchOptions = {},
): ScoringResult {
  const base = computeScores(v);
  const alleFelder: readonly Maybe<unknown>[] = [
    v.security.mintAuthorityActive, v.security.freezeAuthorityActive,
    v.security.top10HolderSharePct, v.security.topHolderSharePct,
    v.market.priceUsd, v.market.liquidityUsd, v.market.marketCapUsd, v.market.volume24hUsd,
    v.momentum.buys5m, v.momentum.sells5m,
    v.execution.exitCapacityRatio, v.execution.priceImpactBps, v.execution.expectedCostBps,
  ];
  // Im Offensiv-Modus traegt nur der Preis — alles andere verbessert die
  // Entscheidung, haelt sie aber nicht auf.
  const required: readonly Maybe<unknown>[] =
    options.partial === true ? [v.market.priceUsd] : alleFelder;
  const buys = v.momentum.buys5m, sells = v.momentum.sells5m;
  const activity = isPresent(buys) && isPresent(sells) && buys.value + sells.value > 0
    ? scored(score(100 * buys.value / (buys.value + sells.value)), [{
        code: "LAUNCH_BUY_SHARE", detail: "Buy transaction share in provider's observed 5m window; not price momentum or unique buyers",
      }]) : notComputable(["momentum.buys5m", "momentum.sells5m"]);
  const subScores = { ...base.subScores, momentum: activity };
  const components = [[subScores.security, .35], [subScores.liquidity, .25],
    [subScores.execution, .25], [activity, .15]] as const;
  const coverage = components.reduce((n, [s, w]) => n + (isScored(s) ? w : 0), 0);
  const complete = required.every(isPresent);
  const summe = components.reduce((n, [s, w]) => n + (isScored(s) ? s.score * w : 0), 0);
  /*
   * Der Endscore.
   *
   * Streng: alle Pflichtfelder UND alle Teilbewertungen, dann die gewichtete
   * Summe. Offensiv: der Preis muss da sein und mindestens eine Teilbewertung
   * rechenbar, dann die Summe NORMIERT auf das abgedeckte Gewicht. Ohne diese
   * Normierung waere eine einzige Teilbewertung mit Gewicht 0.15 automatisch
   * ein miserabler Gesamtscore — eine Zahl, die Unwissen als Urteil ausgibt.
   */
  const finalScore = options.partial === true
    ? complete && coverage > 0 ? score(summe / coverage) : null
    : complete && components.every(([s]) => isScored(s)) ? score(summe) : null;
  return { ...base,
    scoreEngineVersion:
      options.partial === true ? "paper-launch-partial-1.0.0" : "paper-launch-1.0.0",
    subScores,
    finalScore,
    weightCoverage: coverage,
    // Gemessen wird immer an ALLEN dreizehn Feldern, auch im Offensiv-Modus.
    // Sonst stuende dort 100 Prozent, weil die Messlatte mitgesenkt wurde —
    // und die Zahl, die die Datenlage beschreiben soll, waere wertlos.
    dataCompleteness: alleFelder.filter(isPresent).length / alleFelder.length,
    missingFields: collectMissing(v), drivers: components.flatMap(([s]) => isScored(s) ? s.drivers : []),
    notComputable: base.notComputable.filter((s) => s !== "momentum" || !isScored(activity)),
  };
}
