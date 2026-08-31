import { wilsonInterval } from "@sae/analytics";

import { adjustedZ, DEFAULT_ALPHA, expectedFalsePositives } from "./multiple-testing";

/**
 * Was traegt ein einzelnes Feature bei?
 *
 * §85 bis §89 wollen vier Antworten: Beitrag, Wechselwirkung, Grenznutzen,
 * Zerfall. Alle vier haben dasselbe Grundproblem — es ist sehr leicht, in
 * eigenen Daten einen Zusammenhang zu finden, den es nicht gibt.
 *
 * Drei Vorkehrungen ziehen sich deshalb durch das ganze Modul:
 *
 * 1. **Kein Urteil unter der Mindeststichprobe.** Und zwar je Zelle, nicht
 *    insgesamt: eine Wechselwirkung braucht vier belegte Zellen, nicht eine
 *    grosse Gesamtzahl.
 * 2. **Ueberlappende Intervalle sind kein Unterschied.** Wenn sich die
 *    Konfidenzintervalle zweier Gruppen beruehren, ist der beobachtete Abstand
 *    keine Beobachtung.
 * 3. **Die Zahl der Versuche zaehlt mit.** `comparisons` ist Pflichtfeld. Wer
 *    45 Features gegen drei Schwellen prueft, hat 135 Versuche — und findet
 *    rund sieben „Faktoren" allein durch Zufall.
 *
 * Fehlende Featurewerte werden gezaehlt und ausgeschlossen, nie ersetzt. Ein
 * ersetzter Wert waendert die Gruppengroesse und damit genau das, worum es geht.
 */

export interface FeatureObservation {
  /** `null` heisst: der Wert lag nicht vor. Nicht null, nicht Mittelwert. */
  readonly featureValue: number | null;
  /** Nettorendite des abgeschlossenen Trades. */
  readonly netReturn: number;
  readonly at: Date;
}

export interface BucketStats {
  readonly label: string;
  readonly count: number;
  readonly winRate: number | null;
  readonly interval: { readonly lower: number; readonly upper: number } | null;
  readonly meanReturn: number | null;
  readonly medianReturn: number | null;
}

export type Verdict =
  /** Beide Gruppen gross genug UND die Intervalle trennen sich. */
  | "SEPARATED"
  /** Gross genug, aber die Intervalle ueberlappen. Kein Unterschied belegt. */
  | "NO_DIFFERENCE"
  /** Mindestens eine Gruppe zu klein. Gar keine Aussage. */
  | "TOO_LITTLE_DATA";

export interface FeaturePerformance {
  readonly feature: string;
  readonly threshold: number;
  readonly above: BucketStats;
  readonly below: BucketStats;
  /** Beobachtungen ohne Featurewert. Ausgeschlossen, aber sichtbar. */
  readonly missingCount: number;
  readonly verdict: Verdict;
  /** Abstand der Trefferquoten. Nur bei `SEPARATED` aussagekraeftig. */
  readonly winRateGap: number | null;
  readonly better: "ABOVE" | "BELOW" | null;
  readonly comparisons: number;
  readonly note: string;
}

export interface FeatureAnalysisSettings {
  /** Mindestzahl abgeschlossener Trades JE GRUPPE. */
  readonly minPerBucket: number;
  /** Zahl gleichzeitig geprüfter Hypothesen. */
  readonly comparisons: number;
  readonly alpha: number;
}

export const DEFAULT_FEATURE_SETTINGS: FeatureAnalysisSettings = {
  minPerBucket: 100,
  comparisons: 1,
  alpha: DEFAULT_ALPHA,
};

function statsOf(label: string, values: readonly number[], z: number): BucketStats {
  if (values.length === 0) {
    return { label, count: 0, winRate: null, interval: null, meanReturn: null, medianReturn: null };
  }
  const wins = values.filter((v) => v > 0).length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    label,
    count: values.length,
    winRate: wins / values.length,
    interval: wilsonInterval(wins, values.length, z),
    meanReturn: values.reduce((a, b) => a + b, 0) / values.length,
    medianReturn:
      sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
  };
}

function separated(a: BucketStats, b: BucketStats): boolean {
  if (a.interval === null || b.interval === null) return false;
  return a.interval.lower > b.interval.upper || b.interval.lower > a.interval.upper;
}

export function analyzeFeature(input: {
  readonly feature: string;
  readonly observations: readonly FeatureObservation[];
  readonly threshold: number;
  readonly settings?: Partial<FeatureAnalysisSettings>;
}): FeaturePerformance {
  const settings = { ...DEFAULT_FEATURE_SETTINGS, ...input.settings };
  const z = adjustedZ(settings.comparisons, settings.alpha);

  const above: number[] = [];
  const below: number[] = [];
  let missingCount = 0;
  for (const o of input.observations) {
    if (o.featureValue === null) missingCount += 1;
    else if (o.featureValue >= input.threshold) above.push(o.netReturn);
    else below.push(o.netReturn);
  }

  const aboveStats = statsOf(`>= ${input.threshold}`, above, z);
  const belowStats = statsOf(`< ${input.threshold}`, below, z);

  const enough =
    aboveStats.count >= settings.minPerBucket && belowStats.count >= settings.minPerBucket;

  if (!enough) {
    return {
      feature: input.feature,
      threshold: input.threshold,
      above: aboveStats,
      below: belowStats,
      missingCount,
      verdict: "TOO_LITTLE_DATA",
      winRateGap: null,
      better: null,
      comparisons: settings.comparisons,
      note:
        `Kein Urteil: ${aboveStats.count} / ${belowStats.count} Trades, ` +
        `mindestens ${settings.minPerBucket} je Gruppe noetig.`,
    };
  }

  const isSeparated = separated(aboveStats, belowStats);
  const gap = (aboveStats.winRate ?? 0) - (belowStats.winRate ?? 0);

  return {
    feature: input.feature,
    threshold: input.threshold,
    above: aboveStats,
    below: belowStats,
    missingCount,
    verdict: isSeparated ? "SEPARATED" : "NO_DIFFERENCE",
    winRateGap: isSeparated ? gap : null,
    better: isSeparated ? (gap > 0 ? "ABOVE" : "BELOW") : null,
    note: isSeparated
      ? `Getrennt bei ${settings.comparisons} Vergleichen (z = ${z.toFixed(2)}).`
      : `Intervalle ueberlappen — kein belegter Unterschied. ` +
        `Bei ${settings.comparisons} Vergleichen waeren ` +
        `${expectedFalsePositives(settings.comparisons, settings.alpha).toFixed(1)} ` +
        "Scheinbefunde zu erwarten.",
    comparisons: settings.comparisons,
  };
}

/* ---------------------------------------------------------------- §86 */

export type InteractionKind =
  /** Zusammen mehr als die Summe der Einzelbeitraege. */
  | "SYNERGY"
  /** Zusammen weniger — die beiden Features sagen dasselbe. */
  | "REDUNDANT"
  /** Kein erkennbarer Unterschied zur Summe. */
  | "ADDITIVE"
  | "TOO_LITTLE_DATA";

export interface InteractionResult {
  readonly featureA: string;
  readonly featureB: string;
  readonly cells: Readonly<Record<"bothHigh" | "aOnly" | "bOnly" | "neither", BucketStats>>;
  readonly kind: InteractionKind;
  /** Beobachteter Zusatz gegenueber der Summe der Einzelbeitraege. */
  readonly excessOverAdditive: number | null;
  readonly note: string;
}

export function analyzeInteraction(input: {
  readonly featureA: string;
  readonly featureB: string;
  readonly thresholdA: number;
  readonly thresholdB: number;
  readonly observations: readonly {
    readonly a: number | null;
    readonly b: number | null;
    readonly netReturn: number;
  }[];
  readonly settings?: Partial<FeatureAnalysisSettings>;
}): InteractionResult {
  const settings = { ...DEFAULT_FEATURE_SETTINGS, ...input.settings };
  const z = adjustedZ(settings.comparisons, settings.alpha);

  const buckets = { bothHigh: [] as number[], aOnly: [] as number[], bOnly: [] as number[], neither: [] as number[] };
  for (const o of input.observations) {
    if (o.a === null || o.b === null) continue;
    const highA = o.a >= input.thresholdA;
    const highB = o.b >= input.thresholdB;
    if (highA && highB) buckets.bothHigh.push(o.netReturn);
    else if (highA) buckets.aOnly.push(o.netReturn);
    else if (highB) buckets.bOnly.push(o.netReturn);
    else buckets.neither.push(o.netReturn);
  }

  const cells = {
    bothHigh: statsOf("A+ B+", buckets.bothHigh, z),
    aOnly: statsOf("A+ B-", buckets.aOnly, z),
    bOnly: statsOf("A- B+", buckets.bOnly, z),
    neither: statsOf("A- B-", buckets.neither, z),
  } as const;

  // Vier Zellen brauchen vier belegte Zellen. Eine grosse Gesamtzahl mit einer
  // fast leeren Zelle ergibt eine Wechselwirkung, die an drei Trades haengt.
  const thin = Object.values(cells).filter((c) => c.count < settings.minPerBucket);
  if (thin.length > 0) {
    return {
      featureA: input.featureA,
      featureB: input.featureB,
      cells,
      kind: "TOO_LITTLE_DATA",
      excessOverAdditive: null,
      note: `Kein Urteil: ${thin.map((c) => `${c.label}=${c.count}`).join(", ")} unter ${settings.minPerBucket}.`,
    };
  }

  const base = cells.neither.winRate!;
  const effectA = cells.aOnly.winRate! - base;
  const effectB = cells.bOnly.winRate! - base;
  const effectBoth = cells.bothHigh.winRate! - base;
  const excess = effectBoth - (effectA + effectB);

  // Als Unterschied gilt nur, was das Intervall der gemeinsamen Zelle nicht
  // mehr abdeckt.
  const halfWidth = (cells.bothHigh.interval!.upper - cells.bothHigh.interval!.lower) / 2;
  const kind: InteractionKind =
    excess > halfWidth ? "SYNERGY" : excess < -halfWidth ? "REDUNDANT" : "ADDITIVE";

  return {
    featureA: input.featureA,
    featureB: input.featureB,
    cells,
    kind,
    excessOverAdditive: excess,
    note:
      kind === "ADDITIVE"
        ? "Gemeinsamer Effekt entspricht der Summe — keine Wechselwirkung belegt."
        : kind === "REDUNDANT"
          ? "Zusammen weniger als die Summe: die beiden Features sagen weitgehend dasselbe."
          : "Zusammen mehr als die Summe.",
  };
}

/* ---------------------------------------------------------------- §87 */

export interface MarginalValueResult {
  readonly feature: string;
  /** Trades, die das Gate zusaetzlich aussortiert haette. */
  readonly excludedCount: number;
  readonly keptCount: number;
  readonly netReturnWithGate: number | null;
  readonly netReturnWithoutGate: number | null;
  /** Differenz je Trade. Positiv heisst: das Gate haette geholfen. */
  readonly marginalPerTrade: number | null;
  readonly verdict: "MEASURED" | "TOO_LITTLE_DATA" | "GATE_CHANGES_NOTHING";
  readonly note: string;
}

/**
 * Grenznutzen eines zusaetzlichen Gates.
 *
 * Gemessen auf DERSELBEN Menge, nicht auf zwei Stichproben. Zwei getrennte
 * Laeufe unterscheiden sich schon durch ihre Zusammensetzung, und dann misst
 * man die Auswahl statt das Gate.
 */
export function analyzeMarginalValue(input: {
  readonly feature: string;
  readonly threshold: number;
  readonly observations: readonly FeatureObservation[];
  readonly settings?: Partial<FeatureAnalysisSettings>;
}): MarginalValueResult {
  const settings = { ...DEFAULT_FEATURE_SETTINGS, ...input.settings };

  const kept: number[] = [];
  const excluded: number[] = [];
  for (const o of input.observations) {
    // Ohne Featurewert kann das Gate nicht greifen: solche Trades bleiben drin.
    // Sie stillschweigend auszuschliessen waere die bequemste Art, ein Gate gut
    // aussehen zu lassen.
    if (o.featureValue === null || o.featureValue >= input.threshold) kept.push(o.netReturn);
    else excluded.push(o.netReturn);
  }

  const total = kept.length + excluded.length;
  if (total < settings.minPerBucket) {
    return {
      feature: input.feature,
      excludedCount: excluded.length,
      keptCount: kept.length,
      netReturnWithGate: null,
      netReturnWithoutGate: null,
      marginalPerTrade: null,
      verdict: "TOO_LITTLE_DATA",
      note: `Kein Urteil: ${total} Trades, mindestens ${settings.minPerBucket} noetig.`,
    };
  }
  if (excluded.length === 0) {
    return {
      feature: input.feature,
      excludedCount: 0,
      keptCount: kept.length,
      netReturnWithGate: null,
      netReturnWithoutGate: null,
      marginalPerTrade: null,
      verdict: "GATE_CHANGES_NOTHING",
      note: "Das Gate haette keinen einzigen Trade verhindert.",
    };
  }

  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const withGate = mean(kept);
  const without = mean([...kept, ...excluded]);

  return {
    feature: input.feature,
    excludedCount: excluded.length,
    keptCount: kept.length,
    netReturnWithGate: withGate,
    netReturnWithoutGate: without,
    marginalPerTrade: withGate - without,
    verdict: "MEASURED",
    note:
      `Gate haette ${excluded.length} von ${total} Trades verhindert ` +
      `(${((excluded.length / total) * 100).toFixed(0)} %).`,
  };
}

/* ---------------------------------------------------------------- §88/§89 */

export interface DecayBlock {
  readonly index: number;
  readonly from: Date;
  readonly to: Date;
  readonly stats: BucketStats;
}

export interface DecayResult {
  readonly feature: string;
  readonly blocks: readonly DecayBlock[];
  readonly direction: "DECAYING" | "STABLE" | "STRENGTHENING" | "TOO_LITTLE_DATA";
  readonly note: string;
}

/**
 * Zerfaellt der Vorteil eines Features ueber die Zeit?
 *
 * In gleich grosse Zeitbloecke geteilt, nicht in gleich grosse Stichproben:
 * Zerfall ist eine Aussage ueber die Zeit, und gleich grosse Stichproben
 * verzerren sie genau dann, wenn die Handelsfrequenz sich geaendert hat.
 *
 * Ein Trend wird nur behauptet, wenn sich die Intervalle des ersten und des
 * letzten Blocks trennen. Bei drei Bloecken sieht fast jede Zufallsfolge nach
 * Trend aus.
 */
export function analyzeDecay(input: {
  readonly feature: string;
  readonly threshold: number;
  readonly observations: readonly FeatureObservation[];
  readonly blocks: number;
  readonly settings?: Partial<FeatureAnalysisSettings>;
}): DecayResult {
  const settings = { ...DEFAULT_FEATURE_SETTINGS, ...input.settings };
  const z = adjustedZ(settings.comparisons, settings.alpha);

  const withValue = input.observations
    .filter((o) => o.featureValue !== null && o.featureValue >= input.threshold)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (withValue.length === 0 || input.blocks < 2) {
    return {
      feature: input.feature,
      blocks: [],
      direction: "TOO_LITTLE_DATA",
      note: "Zu wenige Beobachtungen ueber der Schwelle.",
    };
  }

  const start = withValue[0]!.at.getTime();
  const end = withValue[withValue.length - 1]!.at.getTime();
  const span = end - start;
  if (span <= 0) {
    return {
      feature: input.feature,
      blocks: [],
      direction: "TOO_LITTLE_DATA",
      note: "Alle Beobachtungen aus demselben Moment — kein Zeitverlauf.",
    };
  }

  const width = span / input.blocks;
  const blocks: DecayBlock[] = [];
  for (let i = 0; i < input.blocks; i += 1) {
    const from = new Date(start + i * width);
    const to = new Date(i === input.blocks - 1 ? end + 1 : start + (i + 1) * width);
    const values = withValue
      .filter((o) => o.at.getTime() >= from.getTime() && o.at.getTime() < to.getTime())
      .map((o) => o.netReturn);
    blocks.push({ index: i, from, to, stats: statsOf(`Block ${i + 1}`, values, z) });
  }

  const first = blocks[0]!.stats;
  const last = blocks[blocks.length - 1]!.stats;
  const thin = blocks.filter((b) => b.stats.count < settings.minPerBucket);

  if (thin.length > 0) {
    return {
      feature: input.feature,
      blocks,
      direction: "TOO_LITTLE_DATA",
      note: `Kein Urteil: ${thin.length} von ${blocks.length} Bloecken unter ${settings.minPerBucket} Trades.`,
    };
  }

  if (!separated(first, last)) {
    return {
      feature: input.feature,
      blocks,
      direction: "STABLE",
      note: "Erster und letzter Block ueberlappen — kein belegter Zerfall.",
    };
  }

  const falling = last.winRate! < first.winRate!;
  return {
    feature: input.feature,
    blocks,
    direction: falling ? "DECAYING" : "STRENGTHENING",
    note:
      `Trefferquote ${(first.winRate! * 100).toFixed(0)} % → ` +
      `${(last.winRate! * 100).toFixed(0)} %, Intervalle getrennt.`,
  };
}
