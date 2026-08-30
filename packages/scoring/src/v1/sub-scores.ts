import { isPresent, score, type Reason } from "@sae/core";
import type { FeatureVector } from "../features";
import {
  notComputable,
  rampDown,
  rampUp,
  scored,
  type SubScoreResult,
} from "../sub-score";

/**
 * Teilscores, Version 1.0.0.
 *
 * ALLE Schwellwerte hier sind begruendete Ausgangswerte, KEINE validierten
 * Parameter. Keiner von ihnen ist gegen Daten geprueft. Sie sind der Startpunkt
 * fuer Backtest und Paper Trading, nicht deren Ergebnis.
 *
 * Jede Funktion ist rein: gleicher Feature-Vektor, gleicher Score. Das ist die
 * Voraussetzung fuer Golden-File-Tests, die eine unbeabsichtigte Verschiebung
 * der Historie sichtbar machen.
 */

const reason = (code: string, detail: string): Reason => ({ code, detail });

/**
 * Sicherheit.
 *
 * Bewusst kein Durchschnitt: die Merkmale sind nicht gleichwertig. Eine aktive
 * Mint-Authority erlaubt beliebige Nachpraegung — dagegen hilft keine gute
 * Holder-Verteilung. Sie deckelt den Score deshalb hart, statt ihn nur zu senken.
 */
export function securityScore(v: FeatureVector): SubScoreResult {
  const mintAuthority = v.security.mintAuthorityActive;
  const freezeAuthority = v.security.freezeAuthorityActive;
  const top10Share = v.security.top10HolderSharePct;

  const missing: string[] = [];
  if (!isPresent(mintAuthority)) missing.push("security.mintAuthorityActive");
  if (!isPresent(freezeAuthority)) missing.push("security.freezeAuthorityActive");
  if (!isPresent(top10Share)) missing.push("security.top10HolderSharePct");
  // Ohne diese drei ist keine Sicherheitsaussage moeglich — auch keine vorsichtige.
  if (!isPresent(mintAuthority) || !isPresent(freezeAuthority) || !isPresent(top10Share)) {
    return notComputable(missing);
  }

  const drivers: Reason[] = [];
  let value = 100;
  let cap = 100;

  if (mintAuthority.value) {
    cap = Math.min(cap, 10);
    drivers.push(reason("MINT_AUTHORITY_ACTIVE", "Beliebige Nachpraegung moeglich"));
  }
  if (freezeAuthority.value) {
    cap = Math.min(cap, 10);
    drivers.push(reason("FREEZE_AUTHORITY_ACTIVE", "Konten koennen eingefroren werden"));
  }

  if (isPresent(v.security.lpBurnedOrLocked) && !v.security.lpBurnedOrLocked.value) {
    // Nicht gesperrte Liquiditaet ist der haeufigste Rug-Mechanismus.
    cap = Math.min(cap, 35);
    drivers.push(reason("LP_UNLOCKED", "Liquiditaet weder verbrannt noch gesperrt"));
  }

  const top10 = top10Share.value;
  const concentrationScore = rampDown(top10, 15, 60);
  value = Math.min(value, concentrationScore);
  if (top10 > 40) {
    drivers.push(reason("HOLDER_CONCENTRATION", `Top-10 halten ${top10.toFixed(1)} %`));
  }

  if (isPresent(v.security.riskLevel)) {
    const level = v.security.riskLevel.value;
    if (level === "CRITICAL") cap = 0;
    else if (level === "HIGH") cap = Math.min(cap, 30);
    if (level !== "LOW") drivers.push(reason("RISK_LEVEL", `Sicherheitsbefund: ${level}`));
  }

  return scored(score(Math.min(value, cap)), drivers);
}

/**
 * Liquiditaet.
 *
 * Bewertet die Handelbarkeit, nicht die Groesse. Ein tiefer Pool ist nur dann
 * etwas wert, wenn die geplante Position auch wieder herausgeht — deshalb geht
 * die Ausstiegsfaehigkeit mit ein und deckelt das Ergebnis.
 */
export function liquidityScore(v: FeatureVector): SubScoreResult {
  const liquidityUsd = v.market.liquidityUsd;
  if (!isPresent(liquidityUsd)) return notComputable(["market.liquidityUsd"]);

  const drivers: Reason[] = [];
  const liquidity = liquidityUsd.value;
  let value = rampUp(liquidity, 10_000, 150_000);

  const exitCapacity = v.execution.exitCapacityRatio;
  if (isPresent(exitCapacity)) {
    const ratio = exitCapacity.value;
    // Unter dem Faktor 1 geht die geplante Position nicht einmal einfach heraus.
    const exitScore = rampUp(ratio, 1, 5);
    value = Math.min(value, exitScore);
    if (ratio < 3) {
      drivers.push(reason("THIN_EXIT", `Ausstiegsfaehigkeit nur Faktor ${ratio.toFixed(1)}`));
    }
  } else {
    // Ohne Ausstiegsrechnung bleibt die Aussage unvollstaendig; der Score wird
    // gedeckelt statt so zu tun, als sei die Frage geklaert.
    value = Math.min(value, 60);
    drivers.push(reason("EXIT_UNKNOWN", "Ausstiegsfaehigkeit nicht berechenbar"));
  }

  if (liquidity < 25_000) {
    drivers.push(reason("LOW_LIQUIDITY", `Liquiditaet ${Math.round(liquidity)} USD`));
  }
  return scored(score(value), drivers);
}

/**
 * Momentum.
 *
 * Absolute Preisaenderung allein sagt wenig — ein Sprung ohne Volumen ist meist
 * ein einzelner Kauf. Gewichtet wird deshalb die Beschleunigung: waechst das
 * Volumen mit, und kaufen mehr Adressen als verkaufen?
 */
export function momentumScore(v: FeatureVector): SubScoreResult {
  const priceChange = v.momentum.priceChange5m;
  const volumeAcc = v.momentum.volumeAcceleration;

  const missing: string[] = [];
  if (!isPresent(priceChange)) missing.push("momentum.priceChange5m");
  if (!isPresent(volumeAcc)) missing.push("momentum.volumeAcceleration");
  if (!isPresent(priceChange) || !isPresent(volumeAcc)) return notComputable(missing);

  const drivers: Reason[] = [];
  const priceScore = rampUp(priceChange.value, -0.05, 0.25);
  const volumeScore = rampUp(volumeAcc.value, 0.8, 3);

  let ratioScore = 50;
  const buys5m = v.momentum.buys5m;
  const sells5m = v.momentum.sells5m;
  if (isPresent(buys5m) && isPresent(sells5m)) {
    const buys = buys5m.value;
    const sells = sells5m.value;
    const total = buys + sells;
    if (total > 0) {
      ratioScore = rampUp(buys / total, 0.4, 0.7);
      if (buys / total < 0.45) {
        drivers.push(reason("SELL_PRESSURE", `Nur ${((buys / total) * 100).toFixed(0)} % Kaeufe`));
      }
    }
  } else {
    // Ohne Kauf-/Verkaufszahlen bleibt der Anteil neutral gewichtet — das ist
    // hier vertretbar, weil er nur ein Drittel des Teilscores ausmacht und der
    // fehlende Input in der Datenvollstaendigkeit auftaucht.
    drivers.push(reason("FLOW_UNKNOWN", "Kauf-/Verkaufszahlen nicht verfuegbar"));
  }

  if (volumeAcc.value > 2) {
    drivers.push(reason("VOLUME_ACCELERATION", `Volumen ${volumeAcc.value.toFixed(1)}-fach`));
  }

  const value = 0.35 * priceScore + 0.4 * volumeScore + 0.25 * ratioScore;
  return scored(score(value), drivers);
}

/**
 * Holder.
 *
 * Entscheidend ist die cluster-bereinigte Zahl. Zehn Wallets mit gemeinsamer
 * Funding-Quelle sind ein Akteur; wer sie als zehn Kaeufer zaehlt, verwechselt
 * eine Inszenierung mit Nachfrage.
 */
export function holderScore(v: FeatureVector): SubScoreResult {
  const holders = v.holder.holders;
  if (!isPresent(holders)) return notComputable(["holder.holders"]);

  const drivers: Reason[] = [];
  const distinctActors = v.holder.distinctActors;
  const effectiveHolders = isPresent(distinctActors) ? distinctActors.value : holders.value;

  if (!isPresent(distinctActors)) {
    drivers.push(reason("CLUSTERING_UNKNOWN", "Holderzahl nicht cluster-bereinigt"));
  } else if (distinctActors.value < holders.value * 0.7) {
    const share = (distinctActors.value / holders.value) * 100;
    drivers.push(
      reason("CLUSTERED_HOLDERS", `Nur ${share.toFixed(0)} % der Holder sind eigenstaendig`),
    );
  }

  let value = rampUp(effectiveHolders, 50, 1_500);

  const holderGrowth = v.holder.holderGrowth;
  if (isPresent(holderGrowth)) {
    const growthScore = rampUp(holderGrowth.value, 0, 100);
    value = 0.65 * value + 0.35 * growthScore;
  }

  const largestCluster = v.holder.largestClusterSharePct;
  if (isPresent(largestCluster) && largestCluster.value > 25) {
    const pct = largestCluster.value;
    value = Math.min(value, rampDown(pct, 25, 60));
    drivers.push(reason("DOMINANT_CLUSTER", `Groesster Cluster haelt ${pct.toFixed(0)} %`));
  }

  return scored(score(value), drivers);
}

/**
 * Ausfuehrbarkeit.
 *
 * Der Teilscore, der am haeufigsten fehlt und am seltensten vermisst wird: ein
 * Token kann in jeder anderen Hinsicht ueberzeugen und trotzdem nicht handelbar
 * sein, weil die Ausfuehrungskosten den erwarteten Vorteil auffressen.
 */
export function executionScore(v: FeatureVector): SubScoreResult {
  const expectedCost = v.execution.expectedCostBps;
  if (!isPresent(expectedCost)) return notComputable(["execution.expectedCostBps"]);

  const drivers: Reason[] = [];
  const costBps = expectedCost.value;
  let value = rampDown(costBps, 50, 600);

  if (costBps > 300) {
    drivers.push(reason("HIGH_EXECUTION_COST", `Erwartete Kosten ${costBps} bp`));
  }

  const priceImpact = v.execution.priceImpactBps;
  if (isPresent(priceImpact) && priceImpact.value > 200) {
    value = Math.min(value, 30);
    drivers.push(reason("HIGH_PRICE_IMPACT", `Price Impact ${priceImpact.value} bp`));
  }

  return scored(score(value), drivers);
}

/** Teilscores, die erst in spaeteren Phasen Daten bekommen. */
export function smartMoneyScore(v: FeatureVector): SubScoreResult {
  const buyerObs = v.pending.smartMoneyBuyers;
  if (!isPresent(buyerObs)) return notComputable(["pending.smartMoneyBuyers"]);

  const drivers: Reason[] = [];
  const buyers = buyerObs.value;
  const sellerObs = v.pending.smartMoneySellers;
  const sellers = isPresent(sellerObs) ? sellerObs.value : 0;
  // Verkaufende qualifizierte Wallets sind ein staerkeres Signal als kaufende:
  // wer frueh drin war und aussteigt, weiss in der Regel mehr als wer einsteigt.
  const net = buyers - 2 * sellers;
  if (sellers > 0) {
    drivers.push(reason("SMART_MONEY_EXIT", `${sellers} qualifizierte Wallets verkaufen`));
  }
  if (buyers > 0) {
    drivers.push(reason("SMART_MONEY_ENTRY", `${buyers} qualifizierte Wallets kaufen`));
  }
  return scored(score(rampUp(net, 0, 8)), drivers);
}

export function socialScore(v: FeatureVector): SubScoreResult {
  const authenticityObs = v.pending.socialAuthenticity;
  const momentumObs = v.pending.socialMomentum;

  const missing: string[] = [];
  if (!isPresent(authenticityObs)) missing.push("pending.socialAuthenticity");
  if (!isPresent(momentumObs)) missing.push("pending.socialMomentum");
  if (!isPresent(authenticityObs) || !isPresent(momentumObs)) return notComputable(missing);

  // Reichweite ohne Echtheit ist wertlos: 20.000 gekaufte Follower sind kein
  // Signal. Die Authentizitaet deckelt deshalb das Momentum, statt sich mit ihm
  // zu mitteln.
  const authenticity = authenticityObs.value;
  const momentum = momentumObs.value;
  return scored(score(Math.min(momentum, authenticity)), [
    ...(authenticity < 50
      ? [reason("LOW_SOCIAL_AUTHENTICITY", `Authentizitaet ${authenticity}`)]
      : []),
  ]);
}

export function devScore(v: FeatureVector): SubScoreResult {
  const obs = v.pending.devScore;
  if (!isPresent(obs)) return notComputable(["pending.devScore"]);
  return scored(score(obs.value));
}

export function narrativeScore(v: FeatureVector): SubScoreResult {
  const obs = v.pending.narrativeScore;
  if (!isPresent(obs)) return notComputable(["pending.narrativeScore"]);
  return scored(score(obs.value));
}
