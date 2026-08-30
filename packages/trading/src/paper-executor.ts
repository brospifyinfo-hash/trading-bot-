import {
  applyBps,
  bps,
  differenceBps,
  isPresent,
  type Bps,
  type Clock,
  type Money,
} from "@sae/core";
import {
  estimateExecutionCosts,
  type FeeAssumptions,
  type LatencyAssumptions,
} from "@sae/simulation";
import type { Executor, ExecutionOutcome, ExecutionPlan, QuoteSource } from "./executor";

/**
 * Simulierte Ausfuehrung.
 *
 * Kein vereinfachter Pfad: derselbe Quote, dasselbe Kostenmodell, dieselbe
 * Fee-Strategie wie live. Was hier NICHT passiert, ist ausschliesslich das
 * Signieren und Senden.
 *
 * Zu Teilausfuehrungen: auf Solana-AMMs gibt es keine Teilausfuehrung im
 * Orderbuchsinn — eine Swap-Transaktion geht ganz durch oder revertiert.
 * Modelliert wird deshalb der realistische Fall: Fehlschlag bei ueberschrittener
 * Slippage, mit anfallenden Gebuehren und ohne Gegenwert.
 */

export interface PaperExecutorOptions {
  readonly clock: Clock;
  readonly quotes: QuoteSource;
  readonly fees: FeeAssumptions;
  readonly latency: LatencyAssumptions;
  /** Preis von 1 SOL in Portfoliowaehrung, fuer die Umrechnung der Chain-Kosten. */
  readonly solPrice: Money;
  readonly dexFeeBps: Bps;
  /**
   * Ziehung fuer den Fehlschlag-Wuerfel, 0..1. Injiziert statt Math.random,
   * damit Backtests reproduzierbar bleiben — ein Backtest, der bei jedem Lauf
   * etwas anderes ergibt, ist keine Messung.
   */
  readonly random: () => number;
  /**
   * Ungünstige Preisdrift zwischen Quote und Fill, 0..1 als Anteil.
   * Ebenfalls injiziert; im Betrieb aus der gemessenen Verteilung.
   */
  readonly driftSample: () => number;
}

export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  readonly #options: PaperExecutorOptions;

  constructor(options: PaperExecutorOptions) {
    this.#options = options;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionOutcome> {
    const { clock, quotes, random, driftSample } = this.#options;

    const quote = await quotes.quote(plan);
    if (!isPresent(quote)) {
      // Ohne Quote gibt es keinen Preis — und ohne Preis keinen simulierten Fill.
      // Ein geschaetzter Ersatzwert waere genau die Art Erfindung, die eine
      // Paper-Statistik wertlos macht.
      return { kind: "ABORTED", reason: "NO_QUOTE", abortedAt: clock.now() };
    }

    const costs = estimateExecutionCosts({
      notional: plan.notional,
      dexFeeBps: this.#options.dexFeeBps,
      priceImpactBps: quote.value.priceImpactBps,
      solPrice: this.#options.solPrice,
      fees: this.#options.fees,
      latency: this.#options.latency,
    });

    // Preisdrift zwischen Quote und Fill. Sie geht IMMER zulasten des Trades:
    // wer davon ausgeht, dass die Verzoegerung ihm auch mal nuetzt, mittelt einen
    // Vorteil ein, den er im Live-Betrieb nicht bekommt.
    const driftFraction = Math.max(0, driftSample());
    const driftBps = bps(Math.round(driftFraction * 10_000));
    const expectedOut = quote.value.outAmount;
    const actualOut = expectedOut - applyBps(expectedOut, driftBps, "ceil");

    // Fehlschlag, wenn die Drift die Slippage-Toleranz sprengt — der reale
    // Mechanismus, an dem Solana-Transaktionen scheitern.
    if (driftBps > plan.maxSlippageBps) {
      return {
        kind: "FAILED",
        reason: "SLIPPAGE_EXCEEDED",
        costs,
        signature: null,
        failedAt: clock.now(),
      };
    }

    // Unabhaengiger Fehlschlag aus anderen Gruenden (abgelaufener Blockhash,
    // Programmfehler). Rate kommt aus derselben Annahme wie im Kostenmodell.
    if (random() < this.#options.fees.failureRate) {
      return {
        kind: "FAILED",
        reason: "BLOCKHASH_EXPIRED",
        costs,
        signature: null,
        failedAt: clock.now(),
      };
    }

    const realizedSlippageBps =
      expectedOut === 0n ? bps(0) : bps(Math.abs(differenceBps(expectedOut, actualOut)));

    return {
      kind: "FILLED",
      outAmount: actualOut,
      costs,
      realizedSlippageBps,
      executionDelayMs: this.#options.latency.quoteToFillMs,
      signature: null,
      filledAt: clock.now(),
    };
  }
}
