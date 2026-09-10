import type { Clock } from "@sae/core";
import { describeShape } from "@sae/observability";

import { classifyFailure, type FailureClass } from "../capability";
import { zodContract, type ContractResult, type ResponseContract } from "../contract";
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
 * Der Vertrag ist gemessen und geprueft (siehe unten). `contextSlot` steht im
 * Schema weiterhin als `optional()`, obwohl die Messung es geliefert hat: die
 * Messung belegt EINE Antwort, nicht jede. Ein Quote ohne `contextSlot` fuehrt
 * flussabwaerts zu `NO_CONTEXT_SLOT` und damit zu keinem Preis — das ist die
 * richtige Folge und besser als eine Ablehnung der ganzen Antwort.
 */

export const JUPITER_QUOTE_ENDPOINT = "/quote";

/**
 * Der geprüfte Vertrag.
 *
 * `verified: true`, abgeleitet aus einer echten Antwort vom 2026-09-10 —
 * gemessen vom laufenden Worker, nicht aus der Spezifikation abgeschrieben.
 *
 * **Die Frage, an der alles hing, ist beantwortet: `contextSlot` ist da.**
 * Damit traegt ein Quote einen Messzeitpunkt, und ein Preis bekommt zum
 * ersten Mal ein bekanntes Alter (DECISIONS §96/§97).
 *
 * Die Messung hat ausserdem einen Fehler im Schema aufgedeckt, der jede
 * Antwort abgelehnt haette: `routePlan[].bps` kommt als `null`, und
 * `optional()` erlaubt nur ein FEHLENDES Feld. Siehe `schema.ts`.
 *
 * Die echte Antwort traegt deutlich mehr Felder als die Spezifikation nennt
 * (`swapUsdValue`, `mostReliableAmmsQuoteReport`, `loadedLongtailToken` und
 * weitere). `z.object` verwirft Unbekanntes stillschweigend, statt daran zu
 * scheitern — ein Anbieter, der ein Feld ERGAENZT, hat nichts gebrochen.
 */
export const JUPITER_QUOTE_CONTRACT: ResponseContract<JupiterQuoteResponse> = zodContract({
  schema: quoteResponseSchema,
  schemaVersion: "jupiter-quote-v1@2026-09-10",
  verified: true,
});

/**
 * Kein `NO_ROUTE`-Fall.
 *
 * Er stand hier, wurde aber nie erzeugt: ein Quote ohne Weg kommt als
 * HTTP-Fehler und landet in `FAILED`. Ein Variantentyp, den der Code nie
 * herstellt, ist eine Zusage ueber Verhalten, das es nicht gibt — ein
 * Aufrufer haette einen Zweig dafuer geschrieben, der nie laeuft. Sollte eine
 * Messung zeigen, dass Jupiter „kein Weg" anders beantwortet, kommt die
 * Variante mit diesem Beleg zurueck.
 */
export type QuoteFetchOutcome =
  | {
      readonly kind: "OK";
      readonly quote: JupiterQuoteResponse;
      readonly latencyMs: number;
      readonly httpStatus: number;
    }
  | {
      readonly kind: "SCHEMA_REJECTED";
      readonly reason: string;
      readonly shape: string;
      /** `null`, wenn die Anfrage nie hinausging. */
      readonly httpStatus: number | null;
      readonly latencyMs: number;
    }
  | {
      readonly kind: "FAILED";
      readonly failure: FailureClass;
      readonly reason: string;
      readonly httpStatus: number | null;
      /**
       * Auch ein Fehlschlag hat eine Dauer — und gerade sie ist die
       * interessante: ein Zeitlimit nach acht Sekunden ist ein anderer Befund
       * als eine sofortige Abweisung.
       */
      readonly latencyMs: number;
    };

export interface QuoteFetchDeps {
  /** Fuer die Latenz. Sie wird gemessen, nicht als `0` behauptet. */
  readonly clock: Clock;
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
      // Vor jeder Messung: nichts ging hinaus, also ist die Dauer 0 und keine
      // beschoenigte Zahl.
      return {
        kind: "SCHEMA_REJECTED",
        reason: "Menge muss positiv sein.",
        shape: "",
        httpStatus: null,
        latencyMs: 0,
      };
    }

    const startedAt = this.#deps.clock.now().getTime();
    const elapsed = (): number => Math.max(0, this.#deps.clock.now().getTime() - startedAt);

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
      return {
        kind: "FAILED",
        failure: classifyFailure({ message: reason }),
        reason,
        httpStatus: null,
        latencyMs: elapsed(),
      };
    }

    if (!response.ok) {
      return {
        kind: "FAILED",
        failure: classifyFailure({ httpStatus: response.status, message: body.slice(0, 200) }),
        reason: `HTTP ${String(response.status)}`,
        httpStatus: response.status,
        latencyMs: elapsed(),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        kind: "SCHEMA_REJECTED",
        reason: "Kein gueltiges JSON.",
        shape: "",
        httpStatus: response.status,
        latencyMs: elapsed(),
      };
    }

    const validated: ContractResult<JupiterQuoteResponse> = this.#contract.validate(parsed);
    if (validated.kind !== "VALID") {
      return {
        kind: "SCHEMA_REJECTED",
        reason: validated.reason,
        shape: describeShape(parsed),
        httpStatus: response.status,
        latencyMs: elapsed(),
      };
    }
    return { kind: "OK", quote: validated.value, latencyMs: elapsed(), httpStatus: response.status };
  }

  /** Der Vertrag, sobald er belegt ist — als eine Zeile Umstellung. */
  static get schema(): typeof quoteResponseSchema {
    return quoteResponseSchema;
  }
}
