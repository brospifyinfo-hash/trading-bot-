import {
  err,
  missing,
  observed,
  ok,
  type Maybe,
  type MissingReason,
  type ProviderId,
  type Result,
  type Clock,
} from "@sae/core";
import type { z } from "zod";
import type { TokenBucket } from "./rate-limiter";
import type { CircuitBreaker } from "./circuit-breaker";
import type { ProviderBudget } from "./budget";
import type { HealthTracker } from "./health";

/**
 * HTTP-Zugriff auf externe Anbieter.
 *
 * Drei Dinge passieren hier, die nirgendwo sonst passieren duerfen:
 *
 * 1. Jede Antwort wird gegen ein Schema validiert. Weicht sie ab, ist das
 *    Ergebnis `MISSING(PARSE_FAILED)` — nicht ein halb geparstes Objekt mit
 *    undefined-Feldern, das weiter oben zufaellig zu einer Zahl wird. Ein
 *    Anbieter, der sein Format aendert, faellt damit sofort auf.
 *
 * 2. Jeder Erfolg wird zu einer `Observation` mit Zeitstempel und Quelle. Der
 *    Zeitstempel ist der Moment der ANTWORT, nicht der Anfrage.
 *
 * 3. Rate Limit, Circuit Breaker, Budget und Health werden gemeinsam gefuehrt.
 *    Wer den Client umgeht, umgeht alle vier — deshalb gibt es keinen zweiten Weg.
 */

export interface HttpClientDeps {
  readonly providerId: ProviderId;
  readonly clock: Clock;
  readonly bucket: TokenBucket;
  readonly breaker: CircuitBreaker;
  readonly health: HealthTracker;
  readonly budget?: ProviderBudget;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface HttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export class ProviderHttpClient {
  readonly #deps: HttpClientDeps;

  constructor(deps: HttpClientDeps) {
    this.#deps = deps;
  }

  /**
   * Fuehrt eine Anfrage aus und validiert die Antwort.
   *
   * Gibt immer ein `Maybe` zurueck — nie eine Ausnahme fuer einen erwartbaren
   * Ausfall. Ein Provider, der nicht antwortet, ist ein Betriebszustand, kein
   * Programmierfehler.
   */
  async request<T>(req: HttpRequest, schema: z.ZodType<T>): Promise<Maybe<T>> {
    const { clock, providerId, bucket, breaker, health, budget } = this.#deps;

    if (!breaker.allowsRequest()) {
      return missing("PROVIDER_DOWN", clock.now(), providerId);
    }
    if (budget?.exhausted) {
      return missing("BUDGET_EXCEEDED", clock.now(), providerId);
    }
    if (!bucket.tryTake()) {
      // Bewusst kein Warten: der Aufrufer entscheidet, ob sich der Aufruf
      // spaeter noch lohnt. Bei einer Exit-Pruefung ist das anders als bei
      // Discovery.
      return missing("PROVIDER_RATE_LIMITED", clock.now(), providerId);
    }

    budget?.chargeRequest();
    const startedAt = clock.now().getTime();
    const outcome = await this.#send(req);

    if (!outcome.ok) {
      breaker.recordFailure();
      health.recordFailure(outcome.error.detail);
      return missing(outcome.error.reason, clock.now(), providerId);
    }

    const parsed = schema.safeParse(outcome.value);
    if (!parsed.success) {
      // Formatabweichung ist ein Ausfall, kein Detail: lieber keine Daten als
      // stillschweigend falsch interpretierte.
      breaker.recordFailure();
      health.recordFailure(`Schema-Abweichung: ${parsed.error.issues[0]?.message ?? "unbekannt"}`);
      return missing("PARSE_FAILED", clock.now(), providerId);
    }

    const latencyMs = clock.now().getTime() - startedAt;
    breaker.recordSuccess();
    health.recordSuccess(latencyMs);
    return observed(parsed.data, providerId, clock.now(), { sourceTs: null, confidence: 1 });
  }

  async #send(
    req: HttpRequest,
  ): Promise<Result<unknown, { reason: MissingReason; detail: string }>> {
    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#deps.timeoutMs ?? 8_000);

    try {
      const response = await fetchImpl(req.url, {
        method: req.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(req.body === undefined ? {} : { "content-type": "application/json" }),
          ...req.headers,
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        return err({ reason: "PROVIDER_RATE_LIMITED", detail: "HTTP 429" });
      }
      if (response.status === 404) {
        // Kein Fehler des Anbieters: der Token ist ihm schlicht unbekannt.
        return err({ reason: "NO_DATA_FOR_TOKEN", detail: "HTTP 404" });
      }
      if (!response.ok) {
        return err({ reason: "PROVIDER_DOWN", detail: `HTTP ${response.status}` });
      }

      return ok(await response.json());
    } catch (error: unknown) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      return err({
        reason: isAbort ? "PROVIDER_TIMEOUT" : "PROVIDER_DOWN",
        detail: error instanceof Error ? error.message : "unbekannter Fehler",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
