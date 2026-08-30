import type { Bps, Maybe, Mint, Money, TxSignature } from "@sae/core";
import type { ExecutionCostEstimate } from "@sae/simulation";

/**
 * Ausfuehrungsschnittstelle.
 *
 * Paper und Live implementieren DASSELBE Interface und laufen durch dieselbe
 * Decision-, Risk- und Positionslogik. Der Unterschied liegt allein in der
 * letzten Schicht: der eine signiert und sendet, der andere simuliert.
 *
 * Das ist die Voraussetzung dafuer, dass Paper-Statistiken ueberhaupt etwas
 * ueber den Live-Betrieb aussagen. Zwei getrennte Pfade wuerden auseinander
 * driften, und die Kennzahlen waeren dann eine Aussage ueber den Paper-Pfad —
 * also ueber nichts.
 */

export interface ExecutionPlan {
  readonly intentId: string;
  readonly side: "buy" | "sell";
  readonly inputMint: Mint;
  readonly outputMint: Mint;
  /** Eingesetzte Menge in kleinster Einheit des Eingabe-Mints. */
  readonly inAmount: bigint;
  /** Gegenwert in Portfoliowaehrung — Grundlage der Kostenrechnung. */
  readonly notional: Money;
  readonly maxSlippageBps: Bps;
  readonly plannedAt: Date;
}

export type ExecutionOutcome =
  | {
      readonly kind: "FILLED";
      /** Tatsaechlich erhaltene Menge nach allen Kosten. */
      readonly outAmount: bigint;
      readonly costs: ExecutionCostEstimate;
      /** Differenz zwischen erwarteter und erzielter Ausgabe, in Basispunkten. */
      readonly realizedSlippageBps: Bps;
      readonly executionDelayMs: number;
      readonly signature: TxSignature | null;
      readonly filledAt: Date;
    }
  | {
      /** On-chain fehlgeschlagen: Gebuehren fallen an, Gegenwert nicht. */
      readonly kind: "FAILED";
      readonly reason: "SLIPPAGE_EXCEEDED" | "BLOCKHASH_EXPIRED" | "PROGRAM_ERROR" | "NO_ROUTE";
      readonly costs: ExecutionCostEstimate;
      readonly signature: TxSignature | null;
      readonly failedAt: Date;
    }
  | {
      /** Vor dem Senden abgebrochen — es entstehen keine Kosten. */
      readonly kind: "ABORTED";
      readonly reason: "STALE_QUOTE" | "NO_QUOTE" | "POLICY";
      readonly abortedAt: Date;
    };

export interface Executor {
  readonly mode: "paper" | "live";
  execute(plan: ExecutionPlan): Promise<ExecutionOutcome>;
}

/**
 * Quelle fuer Quotes.
 *
 * Injiziert, damit derselbe PaperExecutor drei Situationen bedienen kann: im
 * Live-Paper-Betrieb den echten Router (ehrlichster verfuegbarer Preis), im
 * Backtest die Pool-Naeherung, im Test einen festen Wert.
 */
export interface QuoteSource {
  quote(plan: ExecutionPlan): Promise<Maybe<{ outAmount: bigint; priceImpactBps: Bps }>>;
}
