import type { Bps, Maybe, Mint, ProviderId } from "@sae/core";

/**
 * Provider-Schnittstellen.
 *
 * Alle Rueckgaben sind `Maybe<T>`: ein Provider, der nichts liefert, liefert
 * `Missing` mit Grund — nicht `null`, nicht `0`, und keine Ausnahme, die weiter
 * oben zufaellig zu einem Defaultwert wird.
 *
 * Die Kategorien sind bewusst getrennt. Ein Anbieter kann mehrere bedienen, aber
 * die Austauschbarkeit haengt daran, dass jede Kategorie fuer sich ersetzbar ist:
 * faellt der Marktdaten-Anbieter aus, soll der Router weiterlaufen.
 */

export type ProviderKind = "market" | "router" | "security" | "holders" | "social";

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  /** Fuer die Provider-Doku: welche Quelle wurde wann geprueft. */
  readonly verifiedAt: string | null;
  readonly docsPath: string;
}

export interface ProviderHealthState {
  readonly status: "HEALTHY" | "DEGRADED" | "DOWN";
  readonly latencyMsP95: number | null;
  readonly errorRate: number;
  readonly budgetUsedPct: number | null;
  readonly lastSuccessAt: Date | null;
  readonly detail: string | null;
}

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  health(): ProviderHealthState;
}

export interface TokenMarket {
  readonly priceUsd: number;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
}

export interface MarketDataProvider extends Provider {
  getTokenMarket(mint: Mint): Promise<Maybe<TokenMarket>>;
}

export interface RouteQuote {
  readonly inputMint: Mint;
  readonly outputMint: Mint;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  /**
   * Mindestausgabemenge laut Quote.
   *
   * ACHTUNG: Das ist NICHT zwingend die on-chain durchgesetzte Untergrenze.
   * Bei Jupiter sagt die Spezifikation ausdruecklich, dass `/swap` diesen Wert
   * nicht zum Bau der Transaktion verwendet. Die verbindliche Untergrenze steht
   * in der gebauten Transaktion und wird dort vom Signer geprueft.
   * Siehe docs/providers/jupiter.md.
   */
  readonly quotedMinOutAmount: bigint;
  readonly priceImpactBps: Bps;
  readonly slippageBps: Bps;
  readonly routeLabels: readonly string[];
  readonly contextSlot: number | null;
}

export interface QuoteRequest {
  readonly inputMint: Mint;
  readonly outputMint: Mint;
  readonly amount: bigint;
  readonly slippageBps: Bps;
  /** Begrenzt die Routenkomplexitaet und damit die Fehlschlagwahrscheinlichkeit. */
  readonly maxAccounts?: number;
  readonly onlyDirectRoutes?: boolean;
}

export interface RouterProvider extends Provider {
  getQuote(request: QuoteRequest): Promise<Maybe<RouteQuote>>;
}
