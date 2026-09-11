import type { Clock } from "@sae/core";
import { describeShape } from "@sae/observability";

import { classifyFailure, type FailureClass } from "../capability";
import { RUGCHECK_REPORT_CONTRACT, type RugcheckReport } from "./report";
import type { ContractResult, ResponseContract } from "../contract";

/**
 * Der Abruf eines RugCheck-Berichts.
 *
 * Ein Token je Anfrage — die API kennt zwar Bulk-POSTs, die verlangen aber
 * einen Schluessel. Der Report-Endpunkt antwortet ohne, und das genuegt.
 *
 * ### Das Rate-Limit ist hier die Architektur
 *
 * Gemessen: `x-rate-limit-limit: 15`, Zeitfenster unbekannt. Der
 * Marktdaten-Takt fragt 25 Token alle 20 Sekunden. Dieser Adapter gehoert
 * deshalb ausdruecklich NICHT dorthin, sondern in einen eigenen, langsamen
 * Anreicherungstakt. Er reicht die Limit-Header durch, damit der Aufrufer
 * sieht, wie nah er der Grenze kommt, statt es zu erfahren, wenn es zu spaet
 * ist.
 */

export const RUGCHECK_DEFAULT_BASE_URL = "https://api.rugcheck.xyz";

export type RugcheckOutcome =
  | {
      readonly kind: "OK";
      readonly report: RugcheckReport;
      readonly latencyMs: number;
      readonly rateLimit: RateLimitHeaders;
    }
  /** Der Anbieter kennt den Token nicht — eine Auskunft, kein Fehler. */
  | { readonly kind: "NOT_FOUND"; readonly latencyMs: number }
  | { readonly kind: "RATE_LIMITED"; readonly latencyMs: number; readonly rateLimit: RateLimitHeaders }
  | { readonly kind: "SCHEMA_REJECTED"; readonly reason: string; readonly shape: string }
  | { readonly kind: "FAILED"; readonly failure: FailureClass; readonly reason: string };

export interface RateLimitHeaders {
  /** `x-rate-limit-limit`. `null`, wenn der Anbieter ihn nicht schickt. */
  readonly limit: number | null;
  readonly remaining: number | null;
}

export interface RugcheckDeps {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly contract?: ResponseContract<RugcheckReport>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class RugcheckReportAdapter {
  readonly #deps: RugcheckDeps;
  readonly #contract: ResponseContract<RugcheckReport>;

  constructor(deps: RugcheckDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? RUGCHECK_REPORT_CONTRACT;
  }

  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  get schemaVersion(): string {
    return this.#contract.schemaVersion;
  }

  /** Oeffentlich, damit ein Test den Pfad gegen die Messung haelt. */
  url(mint: string): string {
    const base = (this.#deps.baseUrl ?? RUGCHECK_DEFAULT_BASE_URL).replace(/\/$/, "");
    return `${base}/v1/tokens/${encodeURIComponent(mint)}/report`;
  }

  async fetchReport(mint: string): Promise<RugcheckOutcome> {
    const startedAt = this.#deps.clock.now().getTime();
    const elapsed = (): number => Math.max(0, this.#deps.clock.now().getTime() - startedAt);

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(this.url(mint), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      body = await response.text();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "FAILED", failure: classifyFailure({ message: reason }), reason };
    }

    const rateLimit = readRateLimit(response);

    // Eigener Ast, nicht als Ausfall: gedrosselt kommt wieder, ausgefallen
    // nicht. Der Aufrufer soll langsamer werden, nicht den Anbieter abschalten.
    if (response.status === 429) return { kind: "RATE_LIMITED", latencyMs: elapsed(), rateLimit };
    if (response.status === 404) return { kind: "NOT_FOUND", latencyMs: elapsed() };

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

    const validated: ContractResult<RugcheckReport> = this.#contract.validate(parsed);
    if (validated.kind !== "VALID") {
      return { kind: "SCHEMA_REJECTED", reason: validated.reason, shape: describeShape(parsed) };
    }
    return { kind: "OK", report: validated.value, latencyMs: elapsed(), rateLimit };
  }
}

/**
 * Die Limit-Header, so wie sie gemessen wurden.
 *
 * `null` statt 0, wenn ein Header fehlt: „nicht geschickt" ist etwas anderes
 * als „keine Anfragen mehr uebrig", und der Unterschied entscheidet, ob der
 * Aufrufer pausiert oder weitermacht.
 */
function readRateLimit(response: Response): RateLimitHeaders {
  const num = (name: string): number | null => {
    const raw = response.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return { limit: num("x-rate-limit-limit"), remaining: num("x-rate-limit-remaining") };
}
