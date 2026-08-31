/**
 * Zeitstempelkette von der Beobachtung bis zur Bestaetigung.
 *
 * §58 und §106 verlangen, dass jeder Schritt einzeln messbar ist. Der Grund ist
 * nicht Vollstaendigkeit: eine einzelne Gesamtlatenz sagt nicht, ob das System
 * langsam war oder der Mensch — und das sind verschiedene Probleme mit
 * verschiedenen Loesungen. Systemlatenz laesst sich wegprogrammieren,
 * menschliche Reaktionszeit nicht.
 *
 * Zwei Festlegungen, die verhindern, dass die Kette sich selbst schoenrechnet:
 *
 * 1. **Monoton oder Fehler.** Ein Schritt vor seinem Vorgaenger wird nicht auf
 *    null gedeckelt, sondern wirft. Uhren, die zwischen Diensten auseinander
 *    laufen, erzeugen sonst negative Teilzeiten, die sich in einem Mittelwert
 *    gegenseitig aufheben — und die Messung sieht besser aus als die Realitaet.
 * 2. **Je Vorgang, nie gemittelt beim Erfassen** (I-9). Ein Median glaettet
 *    genau die Faelle weg, in denen die Verzoegerung wehtat. Die Simulation
 *    einer Manual-Reaktion bekommt deshalb eine einzelne Kette und niemals eine
 *    Zusammenfassung — das ist unten als Typ durchgesetzt.
 */

export type LatencyStage =
  /** Zeitstempel der Quelle: wann galt der Wert? */
  | "OBSERVED"
  /** Wann hat unser System ihn bekommen? */
  | "INGESTED"
  /** Wann fiel die Entscheidung? */
  | "DECIDED"
  /** Wann ging der Alert raus? (nur Manual) */
  | "ALERTED"
  /** Wann hat der Nutzer ihn geoeffnet? (nur Manual) */
  | "SEEN"
  /** Wann hat der Nutzer geantwortet? (nur Manual) */
  | "RESPONDED"
  /** Wann lag das Quote vor? */
  | "QUOTED"
  /** Wann ging die Transaktion raus? */
  | "SUBMITTED"
  /** Wann war sie bestaetigt? */
  | "CONFIRMED";

export const LATENCY_STAGE_ORDER: readonly LatencyStage[] = [
  "OBSERVED",
  "INGESTED",
  "DECIDED",
  "ALERTED",
  "SEEN",
  "RESPONDED",
  "QUOTED",
  "SUBMITTED",
  "CONFIRMED",
];

/** Die Abschnitte, in denen ein Mensch und nicht das System die Zeit bestimmt. */
const HUMAN_STAGES: ReadonlySet<LatencyStage> = new Set<LatencyStage>([
  "SEEN",
  "RESPONDED",
]);

export type StageTimestamps = Readonly<Partial<Record<LatencyStage, Date>>>;

export class NonMonotonicChainError extends Error {
  constructor(from: LatencyStage, to: LatencyStage, fromAt: Date, toAt: Date) {
    super(
      `Zeitstempelkette laeuft rueckwaerts: ${to} (${toAt.toISOString()}) liegt vor ` +
        `${from} (${fromAt.toISOString()}) — vermutlich Uhrendrift zwischen Diensten.`,
    );
    this.name = "NonMonotonicChainError";
  }
}

export interface LatencySegment {
  readonly from: LatencyStage;
  readonly to: LatencyStage;
  readonly ms: number;
  /**
   * Ob zwischen den beiden Stufen weitere uebersprungen wurden.
   *
   * Ein Auto-Trade hat keinen Alert und keine Nutzerreaktion — der Abschnitt
   * DECIDED→QUOTED ist dann echt und kein Datenverlust. Ohne diese Markierung
   * saehe er spaeter aus wie ein DECIDED→ALERTED, das zufaellig sehr lang war.
   */
  readonly skippedStages: readonly LatencyStage[];
}

export interface LatencyChain {
  readonly stages: StageTimestamps;
  readonly segments: readonly LatencySegment[];
  /** Erste bis letzte vorhandene Stufe. */
  readonly totalMs: number | null;
  /** Summe der Abschnitte, in denen das System die Zeit bestimmt hat. */
  readonly systemMs: number | null;
  /** Alert bis Antwort. `null` im Auto-Strom — dort gibt es keinen Menschen. */
  readonly humanMs: number | null;
  readonly presentStages: readonly LatencyStage[];
  readonly missingStages: readonly LatencyStage[];
}

export function buildLatencyChain(stages: StageTimestamps): LatencyChain {
  const present = LATENCY_STAGE_ORDER.filter((s) => stages[s] !== undefined);
  const missing = LATENCY_STAGE_ORDER.filter((s) => stages[s] === undefined);

  const segments: LatencySegment[] = [];
  for (let i = 1; i < present.length; i += 1) {
    const from = present[i - 1]!;
    const to = present[i]!;
    const fromAt = stages[from]!;
    const toAt = stages[to]!;
    if (toAt.getTime() < fromAt.getTime()) {
      throw new NonMonotonicChainError(from, to, fromAt, toAt);
    }
    const fromIdx = LATENCY_STAGE_ORDER.indexOf(from);
    const toIdx = LATENCY_STAGE_ORDER.indexOf(to);
    segments.push({
      from,
      to,
      ms: toAt.getTime() - fromAt.getTime(),
      skippedStages: LATENCY_STAGE_ORDER.slice(fromIdx + 1, toIdx),
    });
  }

  const first = present[0];
  const last = present[present.length - 1];
  const totalMs =
    first !== undefined && last !== undefined && first !== last
      ? stages[last]!.getTime() - stages[first]!.getTime()
      : null;

  // Menschliche Zeit ist alles, was auf einen Alert folgt und vor dem Quote
  // liegt. Getrennt gefuehrt, weil sie sich nicht wegprogrammieren laesst — und
  // weil eine Gesamtzahl sonst genau die Optimierung anleitet, die nichts
  // bringt.
  const alertedAt = stages.ALERTED;
  const respondedAt = stages.RESPONDED;
  const humanMs =
    alertedAt !== undefined && respondedAt !== undefined
      ? respondedAt.getTime() - alertedAt.getTime()
      : null;

  const systemSegments = segments.filter((s) => !HUMAN_STAGES.has(s.to));
  const systemMs =
    systemSegments.length > 0 ? systemSegments.reduce((sum, s) => sum + s.ms, 0) : null;

  return {
    stages,
    segments,
    totalMs,
    systemMs,
    humanMs,
    presentStages: present,
    missingStages: missing,
  };
}

/** Zeit eines bestimmten Abschnitts, `null` wenn eine der Stufen fehlt. */
export function segmentMs(
  chain: LatencyChain,
  from: LatencyStage,
  to: LatencyStage,
): number | null {
  const fromAt = chain.stages[from];
  const toAt = chain.stages[to];
  if (fromAt === undefined || toAt === undefined) return null;
  return toAt.getTime() - fromAt.getTime();
}

export interface LatencySummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  /**
   * Absichtlich kein Mittelwert.
   *
   * Bei Ausfuehrungszeiten ist der Schwanz die Kostenquelle: ein Mittelwert von
   * 400 ms ist bedeutungslos, wenn jeder zwanzigste Fill vier Sekunden braucht.
   * Wer den Mittelwert optimiert, verbessert die Faelle, die ohnehin schnell
   * waren.
   */
  readonly note: string;
}

export function summarizeLatency(valuesMs: readonly number[]): LatencySummary {
  if (valuesMs.length === 0) {
    return {
      count: 0,
      p50: null,
      p90: null,
      p99: null,
      max: null,
      note: "Keine Messungen.",
    };
  }
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    count: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
    note: "Perzentile, kein Mittelwert: bei Ausfuehrungszeiten zaehlt der Schwanz.",
  };
}

/**
 * Reaktionszeit fuer die Simulation eines Manual-Trades.
 *
 * Nimmt eine EINZELNE Kette entgegen und ausdruecklich keine `LatencySummary`.
 * Das ist I-9 als Typ: mit einem Median simuliert man einen Nutzer, den es
 * nicht gibt, und glaettet genau die Faelle weg, in denen die Verzoegerung
 * wehtat.
 *
 * `null` heisst: diese Gelegenheit hat keine Reaktion — also wird auch keine
 * simuliert. Ein Ersatzwert waere hier eine erfundene Beobachtung.
 */
export function actualResponseMs(chain: LatencyChain): number | null {
  return chain.humanMs;
}
