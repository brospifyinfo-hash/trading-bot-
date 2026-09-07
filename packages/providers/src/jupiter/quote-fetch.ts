import { describeShape } from "@sae/observability";

import { classifyFailure, type FailureClass } from "../capability";
import { unverifiedContract, type ContractResult, type ResponseContract } from "../contract";
import { quoteResponseSchema, type JupiterQuoteResponse } from "./schema";

/**
 * Der Quote-Abruf als Marktdatenquelle.
 *
 * Bewusst getrennt von `JupiterRouterProvider`: der ist der
 * AUSFUEHRUNGS-Pfad und braucht Health-Tracker, Circuit-Breaker und Budget,
 * weil an ihm echte Transaktionen haengen. Hier geht es um eine Messung —
 * dieselbe Antwort, andere Frage, und deshalb dieselbe schlanke Bauform wie
 * beim DexScreener-Adapter.
 *
 * Geteilt wird, worauf es ankommt: **das Schema**. `quoteResponseSchema` ist
 * die eine Definition der Antwortform; zwei Definitionen derselben Antwort
 * laufen irgendwann auseinander, und dann stimmt eine von beiden nicht mehr.
 *
 * Der Vertrag ist ungeprueft, bis eine echte Antwort vorliegt. `contextSlot`
 * steht im Schema als `optional()` — ob das Feld tatsaechlich kommt, ist die
 * Frage, an der der gesamte Weg zum Datenalter haengt (DECISIONS §96/§97).
 * Sie wird gemessen, nicht angenommen.
 */

export const JUPITER_QUOTE_ENDPOINT = "/quote";

export const JUPITER_QUOTE_CONTRACT: ResponseContract<JupiterQuoteResponse> = unverifiedContract({
  provider: "jupiter",
  endpoint: JUPITER_QUOTE_ENDPOINT,
  needed:
    "Eine echte Antwort von GET /quote. Entscheidend ist, ob `contextSlot` " +
    "enthalten ist — ohne ihn gibt es kein Datenalter und damit keine " +
    "Einstiegsentscheidung.",
});

export type QuoteFetchOutcome =
  | { readonly kind: "OK"; readonly quote: JupiterQuoteResponse; readonly latencyMs: number }
  /** Kein Weg zwischen den beiden Token — eine Auskunft, kein Fehler. */
  | { readonly kind: "NO_ROUTE"; readonly latencyMs: number }
  | { readonly kind: "SCHEMA_REJECTED"; readonly reason: string; readonly shape: string }
  | { readonly kind: "FAILED"; readonly failure: FailureClass; readonly reason: string };

export interface QuoteFetchDeps {
  readonly baseUrl: string;
  readonly contract?: ResponseContract<JupiterQuoteResponse>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface QuoteRequestInput {
  readonly inputMint: string;
  readonly outputMint: string;
  /** In kleinster Einheit der Eingabeseite. */
  readonly amountRaw: bigint;
  readonly slippageBps: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class JupiterQuoteAdapter {
  readonly #deps: QuoteFetchDeps;
  readonly #contract: ResponseContract<JupiterQuoteResponse>;

  constructor(deps: QuoteFetchDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? JUPITER_QUOTE_CONTRACT;
  }

  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  /** Oeffentlich, damit ein Test die Parameter gegen die Spezifikation haelt. */
  url(request: QuoteRequestInput): string {
    const query = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amountRaw.toString(),
      slippageBps: String(request.slippageBps),
    });
    return `${this.#deps.baseUrl.replace(/\/$/, "")}${JUPITER_QUOTE_ENDPOINT}?${query.toString()}`;
  }

  async fetchQuote(request: QuoteRequestInput): Promise<QuoteFetchOutcome> {
    if (request.amountRaw <= 0n) {
      return { kind: "SCHEMA_REJECTED", reason: "Menge muss positiv sein.", shape: "" };
    }

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(this.url(request), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      body = await response.text();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "FAILED", failure: classifyFailure({ message: reason }), reason };
    }

    if (!response.ok) {
      return {
        kind: "FAILED",
        failure: classifyFailure({ httpStatus: response.status, message: body.slice(0, 200) }),
        reason: `HTTP ${String(response.status)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: "SCHEMA_REJECTED", reason: "Kein gueltiges JSON.", shape: "" };
    }

    const validated: ContractResult<JupiterQuoteResponse> = this.#contract.validate(parsed);
    if (validated.kind !== "VALID") {
      return { kind: "SCHEMA_REJECTED", reason: validated.reason, shape: describeShape(parsed) };
    }
    return { kind: "OK", quote: validated.value, latencyMs: 0 };
  }

  /** Der Vertrag, sobald er belegt ist — als eine Zeile Umstellung. */
  static get schema(): typeof quoteResponseSchema {
    return quoteResponseSchema;
  }
}
