import { DEFAULT_STRATEGY_PARAMETERS } from "./defaults";
import { parseStrategyParameters } from "./strategy-schema";

/** Research candidate, not an activation flag or a profitability claim (§130). */
export const MEMECOIN_PAPER_CANDIDATE = {
  strategyId: "memecoin-risk-managed",
  version: "1.0.0",
  executionMode: "paper",
  validationStatus: "UNVALIDATED",
  // Total modeled entry + all planned exits; no substitution for measured fees.
  maxRoundTripCostBps: 200,
  parameters: parseStrategyParameters({
    ...DEFAULT_STRATEGY_PARAMETERS,
    risk: {
      ...DEFAULT_STRATEGY_PARAMETERS.risk,
      riskPerTradePct: 0.5,
      maxPositionPct: 3,
      maxPortfolioExposurePct: 10,
      maxDailyLossPct: 3,
      maxOpenPositions: 4,
      maxConsecutiveLosses: 3,
    },
    exit: {
      ...DEFAULT_STRATEGY_PARAMETERS.exit,
      stopLossBps: 2_000,
      takeProfits: [
        { index: 1, triggerGainBps: 2_500, sellPortionBps: 4_000 },
        { index: 2, triggerGainBps: 5_000, sellPortionBps: 3_000 },
        { index: 3, triggerGainBps: 10_000, sellPortionBps: 2_000 },
      ],
      trailingStopBps: 1_500,
      maxHoldingTimeSeconds: 21_600,
    },
  }),
} as const;

/* ------------------------------------------------- Das eine Papier-Konto */

/**
 * Ein Konto, eine frei waehlbare Einstiegsschwelle.
 *
 * Vorher liefen drei Profile nebeneinander — Standard, Offensiv, Sehr
 * offensiv — mit drei getrennten Buchfuehrungen. Das war als Vergleich
 * gedacht und hat im Betrieb das Gegenteil bewirkt: dreimal dieselbe Arbeit
 * je Coin, dreimal dieselben Router-Anfragen, drei Buchungen nebeneinander,
 * und keine davon mit genug Beobachtungen, um etwas auszusagen. Wer drei
 * unvalidierte Strategien gleichzeitig laufen laesst, hat am Ende drei
 * unvalidierte Strategien.
 *
 * Deshalb: EIN Konto, und die eine Zahl, auf die es ankommt, ist einstellbar.
 *
 * ### Warum die Schwelle eine Version ist und keine Variable
 *
 * `strategy_versions` ist unveraenderlich — eine Entscheidung verweist auf
 * die Version, unter der sie gefallen ist. Wuerde die Schwelle in einer
 * bestehenden Version veraendert, waere jede frueher getroffene Entscheidung
 * rueckwirkend an einer Regel gemessen, die zu ihrer Zeit nicht galt. Also
 * traegt jede Schwelle ihre eigene Version (`2.0.0-s50`).
 *
 * Die KONTOFUEHRUNG haengt dagegen an der Strategie-FAMILIE, nicht an der
 * Version. Eine geaenderte Schwelle setzt das Konto deshalb nicht zurueck:
 * Barbestand, offene Positionen und Verlustgrenzen laufen weiter.
 */
export const PAPER_STRATEGY_ID = "memecoin-active-paper";

/*
 * Die GRENZEN der Schwelle stehen bewusst nicht hier, sondern in
 * `@sae/db` neben der Tabelle `paper_settings` — dort steht auch der
 * CHECK-Constraint, der sie durchsetzt. Zwei Listen derselben Grenzen waeren
 * eine Einladung, sie auseinanderlaufen zu lassen, und die Datenbank haette
 * dann recht und der Code unrecht.
 *
 * Diese Datei weiss nur, wie aus einer gueltigen Schwelle ein Kandidat wird.
 */

/**
 * Das Kandidatenprofil zu einer Schwelle.
 *
 * Die uebrigen Tore stehen bewusst FEST und skalieren nicht mit. Sie messen
 * etwas anderes als der Endscore: Sicherheit, Momentum, Liquiditaet und
 * Halterkonzentration sind Mindestbedingungen, keine Geschmacksfrage. Wuerden
 * sie mitwandern, hiesse eine niedrigere Schwelle heimlich auch „weniger
 * Sicherheitspruefung" — und genau das soll die Einstellung nicht koennen.
 */
export function paperCandidate(score: number): {
  readonly strategyId: string;
  readonly version: string;
  readonly executionMode: string;
  readonly validationStatus: string;
  readonly maxRoundTripCostBps: number;
  readonly parameters: ReturnType<typeof parseStrategyParameters>;
} {
  return {
    ...MEMECOIN_PAPER_CANDIDATE,
    strategyId: PAPER_STRATEGY_ID,
    // Die Schwelle steht IM Versionsnamen. Zwei Laeufe mit verschiedenen
    // Schwellen koennen damit nie dieselbe Version benutzen, und im Nachhinein
    // ist an jeder Entscheidung ablesbar, wogegen sie gemessen wurde.
    version: `2.0.0-s${String(score)}`,
    parameters: parseStrategyParameters({
      ...MEMECOIN_PAPER_CANDIDATE.parameters,
      entryGates: {
        ...MEMECOIN_PAPER_CANDIDATE.parameters.entryGates,
        paperLaunchMode: true,
        paperLaunchMinBuys: 1,
        paperLaunchMinBuyShare: 0.3,
        paperLaunchMaxAgeSeconds: 120,
        minTokenAgeSeconds: 0,
        minDataCompleteness: 1,
        // Die eine freie Zahl.
        minFinalScore: score,
        minSecurityScore: 50,
        minMomentumScore: 30,
        minLiquidityUsd: 5_000,
        maxMarketCapUsd: 50_000_000,
        maxTop10HolderSharePct: 60,
      },
      risk: {
        ...MEMECOIN_PAPER_CANDIDATE.parameters.risk,
        riskPerTradePct: 1,
        maxPositionPct: 5,
        maxPortfolioExposurePct: 30,
        maxDailyLossPct: 10,
        maxOpenPositions: 10,
        maxConsecutiveLosses: 8,
        maxSlippageBps: 500,
        maxPriceImpactBps: 500,
        minExitCapacityRatio: 1,
        paperMaxRoundTripCostBps: 600,
      },
    }),
  };
}
