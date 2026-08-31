import { wilsonInterval } from "@sae/analytics";

import { adjustedZ } from "./multiple-testing";

/**
 * Shadow Trading: der Herausforderer sieht dieselben Gelegenheiten.
 *
 * §93 verlangt, dass Champion und Challenger auf derselben Grundlage
 * entscheiden. Der Grund ist ein Vergleichsfehler, der sonst unvermeidlich ist:
 *
 * Laesst man zwei Strategien unabhaengig laufen, handeln sie verschiedene
 * Tokens zu verschiedenen Zeiten. Der anschliessende Vergleich ihrer
 * Trefferquoten misst dann zum grossen Teil, welche Gelegenheiten jede zufaellig
 * gesehen hat — und ein Challenger, der einfach oefter einsteigt, sammelt mehr
 * Gewinner ein, ohne besser zu sein.
 *
 * Deshalb zwei Festlegungen:
 *
 * 1. **Ein Feature-Vektor, zwei Entscheidungen.** Beide bekommen dasselbe
 *    Objekt gereicht, nicht zwei getrennt geladene. Damit ist ausgeschlossen,
 *    dass sie unterschiedliche Datenstaende sehen — und es ist ausgeschlossen,
 *    dass der Challenger einen neueren erwischt.
 * 2. **Verglichen wird paarweise.** Die Faelle, in denen beide gleich
 *    entscheiden, sagen ueber den Unterschied nichts. Aussagekraeftig sind
 *    allein die Gelegenheiten, bei denen sie auseinandergehen — dort wird der
 *    Vergleich gerechnet.
 *
 * Shadow Trading bewegt kein Kapital. Es erzeugt keine Position im
 * Exposure-Buch des Champions und kann seine Limits nicht verbrauchen.
 */

export type ShadowDecision = "ENTER" | "SKIP";

export interface ShadowStrategy<F> {
  readonly id: string;
  decide(features: F): ShadowDecision;
}

export interface ShadowOpportunity<F> {
  readonly opportunityId: string;
  readonly decidedAt: Date;
  /** Der eine Feature-Vektor. Beide Strategien bekommen genau dieses Objekt. */
  readonly features: F;
  /**
   * Hypothetische Nettorendite, wenn eingestiegen worden waere.
   * `null` heisst: der Ausgang steht noch nicht fest — die Gelegenheit zaehlt
   * dann in keiner Auswertung mit, auch nicht als Null.
   */
  readonly hypotheticalReturn: number | null;
}

export type AgreementCell = "BOTH_ENTER" | "CHAMPION_ONLY" | "CHALLENGER_ONLY" | "BOTH_SKIP";

export interface ShadowPair {
  readonly opportunityId: string;
  readonly champion: ShadowDecision;
  readonly challenger: ShadowDecision;
  readonly cell: AgreementCell;
  readonly hypotheticalReturn: number | null;
}

export interface DisagreementStats {
  readonly count: number;
  readonly resolvedCount: number;
  readonly winRate: number | null;
  readonly interval: { readonly lower: number; readonly upper: number } | null;
  readonly meanReturn: number | null;
}

export interface ShadowComparison {
  readonly championId: string;
  readonly challengerId: string;
  readonly pairs: readonly ShadowPair[];
  readonly counts: Readonly<Record<AgreementCell, number>>;
  /** Gelegenheiten, bei denen nur der Champion eingestiegen waere. */
  readonly championOnly: DisagreementStats;
  readonly challengerOnly: DisagreementStats;
  /** Anteil der Gelegenheiten, bei denen beide gleich entschieden haben. */
  readonly agreementRate: number;
  readonly verdict: "CHALLENGER_BETTER" | "CHAMPION_BETTER" | "NO_DIFFERENCE" | "TOO_LITTLE_DATA";
  readonly note: string;
}

export interface ShadowSettings {
  /** Mindestzahl aufgeloester Gelegenheiten JE Abweichungsrichtung. */
  readonly minPerDisagreement: number;
  readonly comparisons: number;
  readonly alpha: number;
}

export const DEFAULT_SHADOW_SETTINGS: ShadowSettings = {
  minPerDisagreement: 50,
  comparisons: 1,
  alpha: 0.05,
};

function statsOf(pairs: readonly ShadowPair[], z: number): DisagreementStats {
  const resolved = pairs
    .map((p) => p.hypotheticalReturn)
    .filter((r): r is number => r !== null);
  if (resolved.length === 0) {
    return { count: pairs.length, resolvedCount: 0, winRate: null, interval: null, meanReturn: null };
  }
  const wins = resolved.filter((r) => r > 0).length;
  return {
    count: pairs.length,
    resolvedCount: resolved.length,
    winRate: wins / resolved.length,
    interval: wilsonInterval(wins, resolved.length, z),
    meanReturn: resolved.reduce((a, b) => a + b, 0) / resolved.length,
  };
}

export function runShadowComparison<F>(input: {
  readonly champion: ShadowStrategy<F>;
  readonly challenger: ShadowStrategy<F>;
  readonly opportunities: readonly ShadowOpportunity<F>[];
  readonly settings?: Partial<ShadowSettings>;
}): ShadowComparison {
  const settings = { ...DEFAULT_SHADOW_SETTINGS, ...input.settings };
  const z = adjustedZ(settings.comparisons, settings.alpha);

  const pairs: ShadowPair[] = input.opportunities.map((o) => {
    // Dasselbe Objekt an beide. Kein zweites Laden, kein zweiter Zeitpunkt.
    const champion = input.champion.decide(o.features);
    const challenger = input.challenger.decide(o.features);
    const cell: AgreementCell =
      champion === "ENTER" && challenger === "ENTER"
        ? "BOTH_ENTER"
        : champion === "ENTER"
          ? "CHAMPION_ONLY"
          : challenger === "ENTER"
            ? "CHALLENGER_ONLY"
            : "BOTH_SKIP";
    return {
      opportunityId: o.opportunityId,
      champion,
      challenger,
      cell,
      hypotheticalReturn: o.hypotheticalReturn,
    };
  });

  const counts: Record<AgreementCell, number> = {
    BOTH_ENTER: 0,
    CHAMPION_ONLY: 0,
    CHALLENGER_ONLY: 0,
    BOTH_SKIP: 0,
  };
  for (const p of pairs) counts[p.cell] += 1;

  const championOnly = statsOf(
    pairs.filter((p) => p.cell === "CHAMPION_ONLY"),
    z,
  );
  const challengerOnly = statsOf(
    pairs.filter((p) => p.cell === "CHALLENGER_ONLY"),
    z,
  );

  const agreementRate =
    pairs.length === 0 ? 1 : (counts.BOTH_ENTER + counts.BOTH_SKIP) / pairs.length;

  const enough =
    championOnly.resolvedCount >= settings.minPerDisagreement &&
    challengerOnly.resolvedCount >= settings.minPerDisagreement;

  if (!enough) {
    return {
      championId: input.champion.id,
      challengerId: input.challenger.id,
      pairs,
      counts,
      championOnly,
      challengerOnly,
      agreementRate,
      verdict: "TOO_LITTLE_DATA",
      note:
        `Kein Urteil: ${championOnly.resolvedCount} / ${challengerOnly.resolvedCount} ` +
        `aufgeloeste Abweichungen, mindestens ${settings.minPerDisagreement} je Richtung noetig. ` +
        `Uebereinstimmung ${(agreementRate * 100).toFixed(0)} %.`,
    };
  }

  const separated =
    championOnly.interval!.lower > challengerOnly.interval!.upper ||
    challengerOnly.interval!.lower > championOnly.interval!.upper;

  if (!separated) {
    return {
      championId: input.champion.id,
      challengerId: input.challenger.id,
      pairs,
      counts,
      championOnly,
      challengerOnly,
      agreementRate,
      verdict: "NO_DIFFERENCE",
      note:
        "Intervalle der Abweichungen ueberlappen — kein belegter Unterschied. " +
        "Der Herausforderer ist damit nicht besser, sondern nur anders.",
    };
  }

  const challengerBetter = (challengerOnly.winRate ?? 0) > (championOnly.winRate ?? 0);
  return {
    championId: input.champion.id,
    challengerId: input.challenger.id,
    pairs,
    counts,
    championOnly,
    challengerOnly,
    agreementRate,
    verdict: challengerBetter ? "CHALLENGER_BETTER" : "CHAMPION_BETTER",
    note:
      `Nur-Champion ${((championOnly.winRate ?? 0) * 100).toFixed(0)} % gegen ` +
      `nur-Challenger ${((challengerOnly.winRate ?? 0) * 100).toFixed(0)} %, Intervalle getrennt. ` +
      `Verglichen wurde auf ${counts.CHAMPION_ONLY + counts.CHALLENGER_ONLY} Abweichungen, ` +
      `die ${counts.BOTH_ENTER + counts.BOTH_SKIP} uebereinstimmenden Faelle sagen zum Unterschied nichts.`,
  };
}
