import { isPresent, score, type Maybe } from "@sae/core";
import { collectMissing, type FeatureVector } from "./features";
import { computeScores, type ScoringResult } from "./v1/engine";
import { isScored, notComputable, scored } from "./sub-score";

/** Paper-only launch model. No fabricated price history and no claim of edge.
 * Transaction counts measure activity, not distinct wallets or price momentum.
 * All required launch inputs must be present; other missing data stays visible.
 */
export function computePaperLaunchScores(v: FeatureVector): ScoringResult {
  const base = computeScores(v);
  const required: readonly Maybe<unknown>[] = [
    v.security.mintAuthorityActive, v.security.freezeAuthorityActive,
    v.security.top10HolderSharePct, v.security.topHolderSharePct,
    v.market.priceUsd, v.market.liquidityUsd, v.market.marketCapUsd, v.market.volume24hUsd,
    v.momentum.buys5m, v.momentum.sells5m,
    v.execution.exitCapacityRatio, v.execution.priceImpactBps, v.execution.expectedCostBps,
  ];
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
  return { ...base, scoreEngineVersion: "paper-launch-1.0.0", subScores,
    finalScore: complete && components.every(([s]) => isScored(s))
      ? score(components.reduce((n, [s, w]) => n + (isScored(s) ? s.score * w : 0), 0)) : null,
    weightCoverage: coverage, dataCompleteness: required.filter(isPresent).length / required.length,
    missingFields: collectMissing(v), drivers: components.flatMap(([s]) => isScored(s) ? s.drivers : []),
    notComputable: base.notComputable.filter((s) => s !== "momentum" || !isScored(activity)),
  };
}
