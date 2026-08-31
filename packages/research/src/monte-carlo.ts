import { mulberry32 } from "@sae/backtest";

/**
 * Monte Carlo ueber die EIGENE Ergebnisverteilung.
 *
 * §49 und §50 wollen wissen, wie schlecht es haette laufen koennen und wie
 * wahrscheinlich ein Totalverlust ist. Zwei Entscheidungen bestimmen, ob die
 * Antwort etwas wert ist:
 *
 * **1. Gezogen wird aus den eigenen Trades, nicht aus einer Normalverteilung.**
 * Memecoin-Renditen sind alles andere als normalverteilt: viele kleine Verluste,
 * seltene sehr grosse Gewinner. Eine angepasste Normalverteilung haette
 * dieselbe Streuung und trotzdem voellig andere Enden — sie unterschaetzt genau
 * das, wonach hier gefragt wird.
 *
 * **2. Simuliert werden Pfade, keine Summen.** Der maximale Rueckgang und die
 * Ruinwahrscheinlichkeit haengen an der REIHENFOLGE. Dieselben Trades in
 * anderer Reihenfolge ergeben dieselbe Endsumme und einen voellig anderen
 * Drawdown — und die Frage „haette ich das ausgehalten" haengt am Drawdown.
 *
 * Der Block-Bootstrap ist deshalb kein Detail: Trades sind zeitlich korreliert,
 * weil Marktphasen zusammenhaengen. Wer unabhaengig zieht, zerlegt jede
 * Verlustserie und bekommt zu freundliche Drawdowns heraus.
 */

export type StakeMode =
  /** Fester Einsatz je Trade. Das Konto kann nicht durch Zinseszins wachsen. */
  | "FIXED"
  /** Anteiliger Einsatz. Gewinne erhoehen den naechsten Einsatz. */
  | "COMPOUND";

export type ResampleMode =
  /** Jeder Trade unabhaengig gezogen. Unterschaetzt Verlustserien. */
  | "IID"
  /** Zusammenhaengende Bloecke gezogen. Erhaelt die Serienstruktur. */
  | "BLOCK";

export interface MonteCarloSettings {
  readonly paths: number;
  readonly tradesPerPath: number;
  readonly seed: number;
  readonly stakeMode: StakeMode;
  /** Anteil des Kapitals je Trade. Nur bei COMPOUND wirksam. */
  readonly stakeFraction: number;
  readonly resample: ResampleMode;
  /** Blocklaenge fuer den Block-Bootstrap. */
  readonly blockLength: number;
  /** Unter diesem Anteil des Startkapitals gilt das Konto als ruiniert. */
  readonly ruinThreshold: number;
}

export const DEFAULT_MONTE_CARLO: MonteCarloSettings = {
  paths: 2_000,
  tradesPerPath: 200,
  seed: 1,
  stakeMode: "COMPOUND",
  stakeFraction: 0.03,
  resample: "BLOCK",
  blockLength: 10,
  ruinThreshold: 0.5,
};

/** Unter dieser Stichprobe zieht der Bootstrap nur dieselben Zahlen neu. */
export const MIN_TRADES_FOR_MONTE_CARLO = 50;

export interface PathOutcome {
  readonly finalEquity: number;
  readonly maxDrawdown: number;
  readonly ruined: boolean;
}

export interface MonteCarloResult {
  readonly paths: number;
  readonly sampleSize: number;
  readonly settings: MonteCarloSettings;
  /** Endkapital als Vielfaches des Startkapitals. */
  readonly equityP05: number | null;
  readonly equityP25: number | null;
  readonly equityMedian: number | null;
  readonly equityP75: number | null;
  readonly equityP95: number | null;
  /** Groesster Rueckgang, als Anteil. */
  readonly drawdownMedian: number | null;
  readonly drawdownP95: number | null;
  readonly drawdownWorst: number | null;
  /** Anteil der Pfade, die unter die Ruinschwelle gefallen sind. */
  readonly riskOfRuin: number | null;
  /** Anteil der Pfade, die mit Verlust enden. */
  readonly probabilityOfLoss: number | null;
  readonly verdict: "MEASURED" | "TOO_LITTLE_DATA";
  readonly note: string;
}

function percentile(sorted: readonly number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}

/**
 * Zieht eine Folge von Renditen aus der Stichprobe.
 *
 * Beim Block-Bootstrap wird ein zufaelliger Startpunkt gewaehlt und von dort
 * `blockLength` aufeinanderfolgende Trades uebernommen — zyklisch, damit das
 * Ende der Stichprobe nicht systematisch seltener vorkommt.
 */
function drawSequence(
  sample: readonly number[],
  count: number,
  random: () => number,
  mode: ResampleMode,
  blockLength: number,
): number[] {
  const out: number[] = [];
  if (mode === "IID") {
    for (let i = 0; i < count; i += 1) {
      out.push(sample[Math.floor(random() * sample.length)]!);
    }
    return out;
  }
  const length = Math.max(1, Math.min(blockLength, sample.length));
  while (out.length < count) {
    const start = Math.floor(random() * sample.length);
    for (let i = 0; i < length && out.length < count; i += 1) {
      out.push(sample[(start + i) % sample.length]!);
    }
  }
  return out;
}

function simulatePath(
  returns: readonly number[],
  settings: MonteCarloSettings,
): PathOutcome {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let ruined = false;

  for (const r of returns) {
    // FIXED: der Einsatz ist unabhaengig vom Kontostand, die Rendite wirkt also
    // absolut. COMPOUND: der Einsatz waechst mit dem Konto.
    equity += settings.stakeMode === "FIXED" ? r * settings.stakeFraction : equity * settings.stakeFraction * r;
    if (equity > peak) peak = equity;
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (equity <= settings.ruinThreshold) {
      ruined = true;
      // Nicht abbrechen: ein Konto, das unter die Schwelle faellt, wird in der
      // Praxis angehalten — der weitere Verlauf ist fuer die Ruinfrage aber
      // ohnehin nicht mehr interessant.
      break;
    }
  }

  return { finalEquity: equity, maxDrawdown, ruined };
}

export function runMonteCarlo(
  netReturns: readonly number[],
  overrides: Partial<MonteCarloSettings> = {},
): MonteCarloResult {
  const settings = { ...DEFAULT_MONTE_CARLO, ...overrides };

  if (netReturns.length < MIN_TRADES_FOR_MONTE_CARLO) {
    return {
      paths: 0,
      sampleSize: netReturns.length,
      settings,
      equityP05: null,
      equityP25: null,
      equityMedian: null,
      equityP75: null,
      equityP95: null,
      drawdownMedian: null,
      drawdownP95: null,
      drawdownWorst: null,
      riskOfRuin: null,
      probabilityOfLoss: null,
      verdict: "TOO_LITTLE_DATA",
      note:
        `${netReturns.length} Trades — unter ${MIN_TRADES_FOR_MONTE_CARLO} zieht der ` +
        "Bootstrap nur dieselben Zahlen neu und erzeugt Sicherheit, die es nicht gibt.",
    };
  }

  const random = mulberry32(settings.seed);
  const outcomes: PathOutcome[] = [];
  for (let i = 0; i < settings.paths; i += 1) {
    const sequence = drawSequence(
      netReturns,
      settings.tradesPerPath,
      random,
      settings.resample,
      settings.blockLength,
    );
    outcomes.push(simulatePath(sequence, settings));
  }

  const equities = outcomes.map((o) => o.finalEquity).sort((a, b) => a - b);
  const drawdowns = outcomes.map((o) => o.maxDrawdown).sort((a, b) => a - b);

  return {
    paths: outcomes.length,
    sampleSize: netReturns.length,
    settings,
    equityP05: percentile(equities, 0.05),
    equityP25: percentile(equities, 0.25),
    equityMedian: percentile(equities, 0.5),
    equityP75: percentile(equities, 0.75),
    equityP95: percentile(equities, 0.95),
    drawdownMedian: percentile(drawdowns, 0.5),
    drawdownP95: percentile(drawdowns, 0.95),
    drawdownWorst: drawdowns[drawdowns.length - 1]!,
    riskOfRuin: outcomes.filter((o) => o.ruined).length / outcomes.length,
    probabilityOfLoss: outcomes.filter((o) => o.finalEquity < 1).length / outcomes.length,
    verdict: "MEASURED",
    note:
      `${settings.paths} Pfade à ${settings.tradesPerPath} Trades, ` +
      `${settings.resample === "BLOCK" ? `Block-Bootstrap (${settings.blockLength})` : "unabhaengig gezogen"}, ` +
      `Seed ${settings.seed}.`,
  };
}

/**
 * Ruingrenze als Gate.
 *
 * §50 verlangt eine Aussage, keine Zahl zum Danebenstellen. Die Schwelle ist
 * eine Festlegung und keine Messung: ein Prozent Ruinwahrscheinlichkeit ueber
 * 200 Trades ist der Punkt, ab dem ich eine Strategie nicht mehr mit echtem
 * Geld laufen liesse.
 */
export const MAX_ACCEPTABLE_RISK_OF_RUIN = 0.01;

export function ruinGate(
  result: MonteCarloResult,
  maxRisk: number = MAX_ACCEPTABLE_RISK_OF_RUIN,
): { readonly passed: boolean; readonly reason: string } {
  if (result.verdict === "TOO_LITTLE_DATA") {
    // Nicht bestanden, nicht „unbekannt": ohne Stichprobe gibt es keine
    // Grundlage, echtes Geld zu riskieren.
    return { passed: false, reason: result.note };
  }
  const risk = result.riskOfRuin ?? 1;
  return {
    passed: risk <= maxRisk,
    reason:
      `Ruinwahrscheinlichkeit ${(risk * 100).toFixed(2)} % ` +
      `(Grenze ${(maxRisk * 100).toFixed(2)} %), ` +
      `Drawdown im 95. Perzentil ${((result.drawdownP95 ?? 0) * 100).toFixed(0)} %.`,
  };
}
