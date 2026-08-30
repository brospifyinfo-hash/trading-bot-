import type { Clock, RejectionReason } from "@sae/core";

/**
 * Live-Revalidierung vor einem manuellen Trade.
 *
 * Zwischen Alert und Klick vergehen Minuten. Bei Memecoins ist das eine
 * Ewigkeit — der Preis kann sich verdoppelt haben, die Liquiditaet abgezogen
 * sein, der Entwickler verkauft haben.
 *
 * Deshalb wird der Zustand komplett neu erhoben und gegen den Alert-Zeitpunkt
 * gestellt. Der Nutzer sieht einen DIFF, keine neue Momentaufnahme: die Frage
 * ist nicht "wie sieht es jetzt aus", sondern "was hat sich geaendert, seit ich
 * die Mail bekam".
 */

export interface MarketSnapshot {
  readonly priceUsd: number;
  readonly liquidityUsd: number;
  readonly finalScore: number;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly at: Date;
}

export interface RevalidationLimits {
  /** Wie weit der Preis ueber dem Alert-Preis liegen darf, als Anteil. */
  readonly maxPriceIncrease: number;
  /** Wie weit der Preis darunter liegen darf. */
  readonly maxPriceDecrease: number;
  /** Mindestanteil der Liquiditaet, der uebrig sein muss. */
  readonly minLiquidityRatio: number;
  /** Wie viele Punkte der Score fallen darf. */
  readonly maxScoreDrop: number;
  readonly maxIntentAgeMs: number;
}

export const DEFAULT_REVALIDATION_LIMITS: RevalidationLimits = {
  maxPriceIncrease: 0.25,
  maxPriceDecrease: 0.3,
  minLiquidityRatio: 0.7,
  maxScoreDrop: 10,
  maxIntentAgeMs: 15 * 60 * 1_000,
};

export interface FieldChange {
  readonly field: string;
  readonly atAlert: string;
  readonly now: string;
  readonly changePct: number | null;
  readonly blocking: boolean;
}

export type RevalidationResult =
  | {
      readonly ok: true;
      /** Kurzlebige Kennung, die der Execution-Worker gegenpruefen muss. */
      readonly revalidationId: string;
      readonly validUntil: Date;
      readonly changes: readonly FieldChange[];
    }
  | {
      readonly ok: false;
      readonly rejectionReasons: readonly RejectionReason[];
      readonly changes: readonly FieldChange[];
      /** Fuer die Anzeige: „Trade expired — market conditions changed." */
      readonly message: string;
    };

/** Wie lange eine Revalidierung gilt. Bewusst kurz. */
export const REVALIDATION_TTL_MS = 60_000;

const pct = (from: number, to: number): number => (from === 0 ? 0 : (to - from) / from);
const fmt = (n: number): string => (Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(4));

export function revalidate(input: {
  readonly atAlert: MarketSnapshot;
  readonly now: MarketSnapshot;
  readonly intentCreatedAt: Date;
  readonly limits?: RevalidationLimits;
  readonly clock: Clock;
  readonly newRevalidationId: () => string;
}): RevalidationResult {
  const limits = input.limits ?? DEFAULT_REVALIDATION_LIMITS;
  const reasons: RejectionReason[] = [];
  const changes: FieldChange[] = [];

  const priceChange = pct(input.atAlert.priceUsd, input.now.priceUsd);
  const priceBlocking =
    priceChange > limits.maxPriceIncrease || priceChange < -limits.maxPriceDecrease;
  if (priceBlocking) reasons.push("DATA_STALE");
  changes.push({
    field: "Preis",
    atAlert: fmt(input.atAlert.priceUsd),
    now: fmt(input.now.priceUsd),
    changePct: priceChange * 100,
    blocking: priceBlocking,
  });

  const liquidityRatio =
    input.atAlert.liquidityUsd === 0 ? 0 : input.now.liquidityUsd / input.atAlert.liquidityUsd;
  const liquidityBlocking = liquidityRatio < limits.minLiquidityRatio;
  if (liquidityBlocking) reasons.push("LIQUIDITY_TOO_LOW");
  changes.push({
    field: "Liquiditaet",
    atAlert: fmt(input.atAlert.liquidityUsd),
    now: fmt(input.now.liquidityUsd),
    changePct: (liquidityRatio - 1) * 100,
    blocking: liquidityBlocking,
  });

  const scoreDrop = input.atAlert.finalScore - input.now.finalScore;
  const scoreBlocking = scoreDrop > limits.maxScoreDrop;
  if (scoreBlocking) reasons.push("FINAL_SCORE_TOO_LOW");
  changes.push({
    field: "Score",
    atAlert: String(input.atAlert.finalScore),
    now: String(input.now.finalScore),
    changePct: null,
    blocking: scoreBlocking,
  });

  // Eine Verschlechterung der Sicherheitsbewertung blockiert immer, unabhaengig
  // von jeder Schwelle. Sie bedeutet, dass die Grundlage des Alerts nicht mehr gilt.
  const securityBlocking =
    riskRank(input.now.riskLevel) > riskRank(input.atAlert.riskLevel) ||
    input.now.riskLevel === "CRITICAL";
  if (securityBlocking) reasons.push("SECURITY_CRITICAL");
  changes.push({
    field: "Risiko",
    atAlert: input.atAlert.riskLevel,
    now: input.now.riskLevel,
    changePct: null,
    blocking: securityBlocking,
  });

  const ageMs = input.clock.now().getTime() - input.intentCreatedAt.getTime();
  if (ageMs > limits.maxIntentAgeMs) reasons.push("DATA_STALE");

  if (reasons.length > 0) {
    return {
      ok: false,
      rejectionReasons: [...new Set(reasons)],
      changes,
      message: "Trade abgelaufen — die Marktbedingungen haben sich veraendert.",
    };
  }

  return {
    ok: true,
    revalidationId: input.newRevalidationId(),
    validUntil: new Date(input.clock.now().getTime() + REVALIDATION_TTL_MS),
    changes,
  };
}

const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
const riskRank = (level: keyof typeof RISK_ORDER): number => RISK_ORDER[level];

/**
 * Letzte Pruefung im Execution-Worker.
 *
 * Die dritte von drei unabhaengigen Pruefungen: Alert, Bestaetigungsseite,
 * Worker. Zwischen jeder vergehen Sekunden — und in Sekunden passiert bei
 * Memecoins genug.
 */
export function acceptRevalidation(input: {
  readonly revalidationId: string;
  readonly expectedId: string;
  readonly validUntil: Date;
  readonly clock: Clock;
}): { readonly ok: boolean; readonly reason: string | null } {
  if (input.revalidationId !== input.expectedId) {
    return { ok: false, reason: "Revalidierung gehoert nicht zu diesem Intent" };
  }
  if (input.clock.now() > input.validUntil) {
    return { ok: false, reason: "Revalidierung ist abgelaufen" };
  }
  return { ok: true, reason: null };
}
