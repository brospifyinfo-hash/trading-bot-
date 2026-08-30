import { money, mulDiv, type Money } from "@sae/core";
import type { StrategyParameters } from "@sae/config";

/**
 * Risikobasierte Positionsgroesse.
 *
 * Vier unabhaengige Obergrenzen, und es gilt die KLEINSTE — nie ein Mittelwert
 * und nie die "passendste". Jede der vier beschreibt eine andere Art, sich zu
 * ruinieren, und keine davon laesst sich durch die anderen ausgleichen.
 *
 * Bei Memecoins bindet fast immer `byLiquidity`. Genau diese Grenze ignorieren
 * die meisten Bots — sie rechnen eine Position aus, die im Backtest funktioniert
 * und im Markt den Preis bewegt, den sie handeln wollten.
 */

export type SizingConstraint =
  | "RISK_BUDGET"
  | "LIQUIDITY"
  | "PORTFOLIO_CAP"
  | "CONFIDENCE"
  | "BELOW_MINIMUM";

export interface SizingInputs {
  readonly portfolioValue: Money;
  /** Relativer Abstand zum Stop, z. B. 0.2 fuer 20 %. */
  readonly stopDistance: number;
  /** Groesstes Volumen, das die Liquiditaet innerhalb der Impact-Grenze hergibt. */
  readonly maxNotionalByLiquidity: Money;
  /** 0..1 — sinkt, solange die EV-Schaetzung auf duenner Stichprobe steht. */
  readonly evConfidence: number;
  /** Unterhalb dieses Volumens lohnt sich der Trade nach Kosten nicht. */
  readonly minimumNotional: Money;
  readonly parameters: StrategyParameters;
}

export interface SizingResult {
  readonly size: Money;
  /** Welche der vier Grenzen tatsaechlich gebunden hat. */
  readonly bindingConstraint: SizingConstraint;
  readonly candidates: Readonly<Record<Exclude<SizingConstraint, "BELOW_MINIMUM">, Money>>;
  /** false, wenn die Position unter dem sinnvollen Minimum liegt. */
  readonly tradeable: boolean;
}

/**
 * Skaliert die Groesse mit der Konfidenz der EV-Schaetzung.
 *
 * Untergrenze 0.25 statt 0: eine schwache Schaetzung soll die Position
 * verkleinern, nicht den Trade heimlich verhindern. Ob ueberhaupt gehandelt
 * wird, entscheiden die Hard Gates — sichtbar und mit Begruendung.
 */
export function confidenceFactor(evConfidence: number): number {
  if (evConfidence < 0 || evConfidence > 1) {
    throw new RangeError(`evConfidence muss in [0,1] liegen, war ${evConfidence}`);
  }
  return 0.25 + 0.75 * evConfidence;
}

export function computePositionSize(input: SizingInputs): SizingResult {
  const { portfolioValue, parameters } = input;
  const currency = portfolioValue.currency;

  if (input.stopDistance <= 0 || input.stopDistance > 1) {
    throw new RangeError(`stopDistance muss in (0,1] liegen, war ${input.stopDistance}`);
  }

  // Risikobudget / Stopabstand: so viel darf hinein, damit der Stop genau das
  // Budget kostet.
  const riskBudgetMinor = mulDiv(
    portfolioValue.minor,
    BigInt(Math.round(parameters.risk.riskPerTradePct * 10_000)),
    1_000_000n,
    "floor",
  );
  const byRisk = money(
    mulDiv(riskBudgetMinor, 10_000n, BigInt(Math.round(input.stopDistance * 10_000)), "floor"),
    currency,
  );

  const byPortfolioCap = money(
    mulDiv(
      portfolioValue.minor,
      BigInt(Math.round(parameters.risk.maxPositionPct * 10_000)),
      1_000_000n,
      "floor",
    ),
    currency,
  );

  const byConfidence = money(
    mulDiv(
      byRisk.minor,
      BigInt(Math.round(confidenceFactor(input.evConfidence) * 10_000)),
      10_000n,
      "floor",
    ),
    currency,
  );

  const candidates = {
    RISK_BUDGET: byRisk,
    LIQUIDITY: input.maxNotionalByLiquidity,
    PORTFOLIO_CAP: byPortfolioCap,
    CONFIDENCE: byConfidence,
  } as const;

  let bindingConstraint: Exclude<SizingConstraint, "BELOW_MINIMUM"> = "RISK_BUDGET";
  let smallest = byRisk.minor;
  for (const [name, value] of Object.entries(candidates) as Array<
    [Exclude<SizingConstraint, "BELOW_MINIMUM">, Money]
  >) {
    if (value.minor < smallest) {
      smallest = value.minor;
      bindingConstraint = name;
    }
  }

  const tradeable = smallest >= input.minimumNotional.minor;
  return {
    size: money(smallest, currency),
    bindingConstraint: tradeable ? bindingConstraint : "BELOW_MINIMUM",
    candidates,
    tradeable,
  };
}
