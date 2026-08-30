import {
  bps,
  isPresent,
  mapObservation,
  mint as toMint,
  providerId,
  type Bps,
  type Maybe,
} from "@sae/core";
import type { ProviderHttpClient } from "../http";
import type { HealthTracker } from "../health";
import type { CircuitBreaker } from "../circuit-breaker";
import type { ProviderBudget } from "../budget";
import type {
  ProviderDescriptor,
  ProviderHealthState,
  QuoteRequest,
  RouteQuote,
  RouterProvider,
} from "../types";
import { quoteResponseSchema, type JupiterQuoteResponse } from "./schema";

export const JUPITER_PROVIDER_ID = providerId("jupiter");

/**
 * Jupiter als Router-Provider.
 *
 * Nur `/quote` ist implementiert. `/swap` gehoert in den Execution-Pfad und
 * kommt in Phase 12 — zusammen mit dem Dekodieren der gebauten Transaktion, aus
 * der die Signer-Policy die tatsaechliche Mindestausgabemenge liest.
 *
 * Die Base-URL ist Konfiguration und hat bewusst keinen Default: die
 * Spezifikation nennt `https://api.jup.ag/swap/v1`, ein freier Tarif unter
 * `lite-api.jup.ag` liess sich in dieser Umgebung nicht verifizieren. Ein
 * fest eingebauter Default wuerde diese Unsicherheit unsichtbar machen.
 */
export class JupiterRouterProvider implements RouterProvider {
  readonly descriptor: ProviderDescriptor = {
    id: JUPITER_PROVIDER_ID,
    kind: "router",
    verifiedAt: "2026-08-30",
    docsPath: "docs/providers/jupiter.md",
  };

  readonly #http: ProviderHttpClient;
  readonly #baseUrl: string;
  readonly #apiKey: string | null;
  readonly #health: HealthTracker;
  readonly #breaker: CircuitBreaker;
  readonly #budget: ProviderBudget | undefined;

  constructor(options: {
    readonly http: ProviderHttpClient;
    /** z. B. "https://api.jup.ag/swap/v1" — ohne abschliessenden Schraegstrich. */
    readonly baseUrl: string;
    readonly apiKey?: string | null;
    readonly health: HealthTracker;
    readonly breaker: CircuitBreaker;
    readonly budget?: ProviderBudget;
  }) {
    this.#http = options.http;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey ?? null;
    this.#health = options.health;
    this.#breaker = options.breaker;
    this.#budget = options.budget;
  }

  health(): ProviderHealthState {
    return this.#health.state({
      breaker: this.#breaker,
      ...(this.#budget ? { budget: this.#budget } : {}),
    });
  }

  async getQuote(request: QuoteRequest): Promise<Maybe<RouteQuote>> {
    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount.toString(),
      slippageBps: String(request.slippageBps),
    });
    if (request.maxAccounts !== undefined) {
      params.set("maxAccounts", String(request.maxAccounts));
    }
    if (request.onlyDirectRoutes !== undefined) {
      params.set("onlyDirectRoutes", String(request.onlyDirectRoutes));
    }

    const response = await this.#http.request(
      {
        url: `${this.#baseUrl}/quote?${params.toString()}`,
        ...(this.#apiKey ? { headers: { "x-api-key": this.#apiKey } } : {}),
      },
      quoteResponseSchema,
    );

    if (!isPresent(response)) return response;
    return mapObservation(response, toRouteQuote);
  }
}

/**
 * Abbildung auf das interne Modell.
 *
 * Hier passieren die beiden Umrechnungen, bei denen ein Fehler teuer waere:
 * Strings zu `bigint` (ohne Umweg ueber `number`) und Dezimalbruch zu
 * Basispunkten.
 */
export function toRouteQuote(raw: JupiterQuoteResponse): RouteQuote {
  return {
    inputMint: toMint(raw.inputMint),
    outputMint: toMint(raw.outputMint),
    inAmount: BigInt(raw.inAmount),
    outAmount: BigInt(raw.outAmount),
    quotedMinOutAmount: BigInt(raw.otherAmountThreshold),
    priceImpactBps: decimalFractionToBps(raw.priceImpactPct),
    slippageBps: bps(raw.slippageBps),
    routeLabels: raw.routePlan.map((step) => step.swapInfo.label ?? step.swapInfo.ammKey),
    contextSlot: raw.contextSlot ?? null,
  };
}

/**
 * "0.0012" → 12 bp.
 *
 * Aufgerundet und auf nicht-negative Werte begrenzt: ein negativer Impact darf
 * die Kostenschaetzung nicht kleinrechnen. Wer einen Vorteil einplant, weil der
 * Router gerade guenstig routet, plant auf einer Annahme, die im naechsten Block
 * nicht mehr gilt.
 */
export function decimalFractionToBps(value: string): Bps {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    throw new TypeError(`priceImpactPct nicht interpretierbar: ${JSON.stringify(value)}`);
  }
  return bps(Math.max(0, Math.ceil(asNumber * 10_000)));
}
