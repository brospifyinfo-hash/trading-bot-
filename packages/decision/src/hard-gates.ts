import { isPresent, type RejectionReason } from "@sae/core";
import type { StrategyParameters } from "@sae/config";
import type { FeatureVector, ScoringResult } from "@sae/scoring";
import { MIN_WEIGHT_COVERAGE } from "@sae/scoring";

/**
 * Hard Gates.
 *
 * Boolesche Killkriterien. Sie ueberschreiben JEDEN Score, und es gibt bewusst
 * keinen Codepfad, der sie umgeht — kein "Score war so gut, wir machen eine
 * Ausnahme". Wer eine Ausnahme braucht, aendert die Strategieversion, und die
 * durchlaeuft Backtest, Paper Trading und eine manuelle Freigabe.
 *
 * Jedes Gate liefert einen Grund aus dem geschlossenen `RejectionReason`-Satz.
 * Freitext waere hier bequem und wuerde das Rejection-Log unauswertbar machen.
 */

export interface GateContext {
  readonly features: FeatureVector;
  readonly scoring: ScoringResult;
  readonly parameters: StrategyParameters;
  /** Kritische Datenquellen ohne verfuegbaren Anbieter. */
  readonly criticalProvidersUnavailable: readonly string[];
  readonly tokenBlacklisted: boolean;
  readonly hasOpenIntentOnMint: boolean;
}

export interface GateResult {
  readonly passed: boolean;
  readonly failures: readonly RejectionReason[];
}

type Gate = (ctx: GateContext) => RejectionReason | null;

/**
 * Reihenfolge ist Absicht: erst die Kriterien, die unabhaengig von jeder
 * Datenqualitaet gelten, dann die datenabhaengigen. So nennt eine Ablehnung den
 * eigentlichen Grund und nicht den Folgefehler.
 */
const GATES: readonly Gate[] = [
  (ctx) => (ctx.tokenBlacklisted ? "TOKEN_BLACKLISTED" : null),
  (ctx) => (ctx.hasOpenIntentOnMint ? "DUPLICATE_OPEN_INTENT" : null),

  (ctx) =>
    ctx.criticalProvidersUnavailable.length > 0 ? "PROVIDER_UNHEALTHY" : null,

  // Zu wenig Datengrundlage ist ein eigener Ablehnungsgrund, kein schlechter Score.
  (ctx) =>
    ctx.scoring.dataCompleteness < ctx.parameters.entryGates.minDataCompleteness
      ? "DATA_INCOMPLETE"
      : null,
  (ctx) => (ctx.scoring.weightCoverage < MIN_WEIGHT_COVERAGE ? "DATA_INCOMPLETE" : null),

  // Sicherheit: die drei Kriterien, bei denen kein Score der Welt hilft.
  (ctx) => {
    const level = ctx.features.security.riskLevel;
    return isPresent(level) && level.value === "CRITICAL" ? "SECURITY_CRITICAL" : null;
  },
  (ctx) => {
    const mint = ctx.features.security.mintAuthorityActive;
    return isPresent(mint) && mint.value ? "MINT_AUTHORITY_ACTIVE" : null;
  },
  (ctx) => {
    const freeze = ctx.features.security.freezeAuthorityActive;
    return isPresent(freeze) && freeze.value ? "FREEZE_AUTHORITY_ACTIVE" : null;
  },
  (ctx) => {
    const lp = ctx.features.security.lpBurnedOrLocked;
    return isPresent(lp) && !lp.value ? "LIQUIDITY_NOT_LOCKED" : null;
  },

  (ctx) => {
    const liquidity = ctx.features.market.liquidityUsd;
    if (!isPresent(liquidity)) return "DATA_INCOMPLETE";
    return liquidity.value < ctx.parameters.entryGates.minLiquidityUsd
      ? "LIQUIDITY_TOO_LOW"
      : null;
  },

  // Ausstiegsfaehigkeit: ein Token kann in jeder anderen Hinsicht ueberzeugen und
  // trotzdem eine Falle sein, weil die Position nicht wieder herausgeht.
  (ctx) => {
    const ratio = ctx.features.execution.exitCapacityRatio;
    if (!isPresent(ratio)) return "DATA_INCOMPLETE";
    return ratio.value < ctx.parameters.risk.minExitCapacityRatio
      ? "EXIT_CAPACITY_INSUFFICIENT"
      : null;
  },

  (ctx) => {
    const top10 = ctx.features.security.top10HolderSharePct;
    if (!isPresent(top10)) return null;
    return top10.value > ctx.parameters.entryGates.maxTop10HolderSharePct
      ? "HOLDER_CONCENTRATION_TOO_HIGH"
      : null;
  },

  (ctx) => {
    const impact = ctx.features.execution.priceImpactBps;
    if (!isPresent(impact)) return null;
    return impact.value > ctx.parameters.risk.maxPriceImpactBps ? "PRICE_IMPACT_TOO_HIGH" : null;
  },

  (ctx) => {
    const age = ctx.features.market.tokenAgeSeconds;
    if (!isPresent(age)) return null;
    return age.value < ctx.parameters.entryGates.minTokenAgeSeconds ? "DATA_INCOMPLETE" : null;
  },

  (ctx) => {
    const cap = ctx.features.market.marketCapUsd;
    if (!isPresent(cap)) return null;
    return cap.value > ctx.parameters.entryGates.maxMarketCapUsd ? "FINAL_SCORE_TOO_LOW" : null;
  },
];

export function evaluateHardGates(ctx: GateContext): GateResult {
  const failures: RejectionReason[] = [];
  for (const gate of GATES) {
    const failure = gate(ctx);
    if (failure !== null && !failures.includes(failure)) failures.push(failure);
  }
  return { passed: failures.length === 0, failures };
}
