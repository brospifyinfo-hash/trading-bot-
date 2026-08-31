import type { Clock, ProviderId } from "@sae/core";

import type { ProviderBudget } from "./budget";
import type { CircuitBreaker } from "./circuit-breaker";
import {
  classifyFailure,
  deriveStatus,
  type FailureClass,
  type ProviderCapability,
  type ProviderStatusReport,
  type RateLimitState,
} from "./capability";
import type { TokenBucket } from "./rate-limiter";
import type { ProviderKind } from "./types";

/**
 * Fuehrt Buch ueber einen Provider und baut daraus den Statusbericht.
 *
 * Der `HealthTracker` beantwortet die Frage der Handelslogik („darf ich diesen
 * Anbieter benutzen"). Dieser Recorder beantwortet die Frage des Betreibers
 * („was ist los und woran liegt es") — und dafuer braucht es Dinge, die der
 * Handelslogik egal sind: wann der letzte Fehler war, was er sagte, wie alt die
 * juengste gelieferte Beobachtung ist.
 *
 * Beides getrennt zu halten ist Absicht. Ein Statusfeld, das gleichzeitig eine
 * Anzeige und ein Gate bedient, wird irgendwann fuer die Anzeige geschoent.
 */

export interface ProviderRecorderOptions {
  readonly providerId: ProviderId;
  readonly kind: ProviderKind;
  readonly capabilities: readonly ProviderCapability[];
  readonly clock: Clock;
  /** Ob Zugangsdaten und Basis-URL vorhanden sind. */
  readonly configured: boolean;
  readonly maxSilenceSeconds?: number;
  readonly degradedErrorRate?: number;
  readonly windowSize?: number;
}

export class ProviderRecorder {
  readonly #options: Required<
    Pick<ProviderRecorderOptions, "maxSilenceSeconds" | "degradedErrorRate" | "windowSize">
  > &
    ProviderRecorderOptions;

  #outcomes: boolean[] = [];
  #latencies: number[] = [];
  #lastSuccessAt: Date | null = null;
  #lastFailureAt: Date | null = null;
  #lastFailureReason: string | null = null;
  #lastFailureClass: FailureClass | null = null;
  /** Beobachtungszeitpunkt der zuletzt gelieferten Daten. */
  #lastObservedAt: Date | null = null;
  #rateLimit: RateLimitState | null = null;

  constructor(options: ProviderRecorderOptions) {
    this.#options = {
      maxSilenceSeconds: 300,
      degradedErrorRate: 0.2,
      windowSize: 50,
      ...options,
    };
  }

  /**
   * Erfolgreicher Aufruf.
   *
   * `observedAt` ist der Zeitstempel der DATEN, nicht des Aufrufs. Fehlt er,
   * bleibt die Frische unbekannt — und wird nicht auf den Abrufzeitpunkt
   * gesetzt: „gerade geholt" ist nicht dasselbe wie „gerade entstanden".
   */
  recordSuccess(input: {
    readonly latencyMs: number;
    readonly observedAt?: Date | null;
    readonly rateLimit?: RateLimitState | null;
  }): void {
    this.#push(true);
    this.#latencies.push(input.latencyMs);
    if (this.#latencies.length > this.#options.windowSize) this.#latencies.shift();
    this.#lastSuccessAt = this.#options.clock.now();
    this.#lastObservedAt = input.observedAt ?? null;
    if (input.rateLimit !== undefined) this.#rateLimit = input.rateLimit;
    // Ein Erfolg loescht den letzten Fehler NICHT: er bleibt als Historie
    // sichtbar. Nur die Klassifikation wird zurueckgesetzt, damit ein alter
    // Fehlschlag den Status nicht dauerhaft festhaelt — ausser bei BLOCKED,
    // das eine Netzsperre beschreibt und erst durch einen Erfolg verschwindet.
    this.#lastFailureClass = null;
  }

  recordFailure(input: {
    readonly httpStatus?: number | null;
    readonly errorCode?: string | null;
    readonly message?: string | null;
    readonly rateLimit?: RateLimitState | null;
  }): void {
    this.#push(false);
    this.#lastFailureAt = this.#options.clock.now();
    this.#lastFailureReason = input.message ?? input.errorCode ?? `HTTP ${input.httpStatus ?? "?"}`;
    this.#lastFailureClass = classifyFailure(input);
    if (input.rateLimit !== undefined) this.#rateLimit = input.rateLimit;
  }

  /** Aktueller Fuellstand des eigenen Buckets, wenn kein Anbieterlimit bekannt ist. */
  attachBucket(bucket: TokenBucket): void {
    this.#rateLimit = {
      remaining: this.#rateLimit?.remaining ?? null,
      limit: this.#rateLimit?.limit ?? null,
      resetAt: this.#rateLimit?.resetAt ?? null,
      localTokensAvailable: bucket.available,
    };
  }

  report(options: { breaker?: CircuitBreaker; budget?: ProviderBudget } = {}): ProviderStatusReport {
    const now = this.#options.clock.now();
    const secondsSinceLastSuccess =
      this.#lastSuccessAt === null
        ? null
        : (now.getTime() - this.#lastSuccessAt.getTime()) / 1_000;

    const status = deriveStatus({
      configured: this.#options.configured,
      lastFailureClass: this.#lastFailureClass,
      hasEverSucceeded: this.#lastSuccessAt !== null,
      errorRate: this.errorRate,
      budgetExhausted: options.budget?.exhausted ?? false,
      breakerOpen: options.breaker?.state === "OPEN",
      secondsSinceLastSuccess,
      maxSilenceSeconds: this.#options.maxSilenceSeconds,
      degradedErrorRate: this.#options.degradedErrorRate,
    });

    return {
      providerId: this.#options.providerId,
      kind: this.#options.kind,
      status,
      capabilities: this.#options.capabilities,
      lastSuccessAt: this.#lastSuccessAt,
      lastFailureAt: this.#lastFailureAt,
      lastFailureReason: this.#lastFailureReason,
      latencyMsP50: this.#percentile(0.5),
      latencyMsP95: this.#percentile(0.95),
      rateLimit: this.#rateLimit,
      dataFreshnessSeconds:
        this.#lastObservedAt === null
          ? null
          : Math.max(0, (now.getTime() - this.#lastObservedAt.getTime()) / 1_000),
      detail: this.#detailFor(status),
    };
  }

  get errorRate(): number {
    if (this.#outcomes.length === 0) return 0;
    return this.#outcomes.filter((ok) => !ok).length / this.#outcomes.length;
  }

  #detailFor(status: ProviderStatusReport["status"]): string | null {
    switch (status) {
      case "NOT_CONFIGURED":
        return "Keine Zugangsdaten oder Basis-URL hinterlegt.";
      case "BLOCKED":
        return this.#lastFailureReason ?? "Verbindung wird vom Netz nicht zugelassen.";
      case "UNAVAILABLE":
        return this.#lastFailureReason ?? "Antwortet nicht.";
      case "DEGRADED":
        return this.#lastFailureReason ?? `Fehlerrate ${(this.errorRate * 100).toFixed(0)} %`;
      default:
        return null;
    }
  }

  #percentile(q: number): number | null {
    if (this.#latencies.length === 0) return null;
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(q * sorted.length));
    return sorted[rank - 1] ?? null;
  }

  #push(ok: boolean): void {
    this.#outcomes.push(ok);
    if (this.#outcomes.length > this.#options.windowSize) this.#outcomes = this.#outcomes.slice(1);
  }
}

/**
 * Zusammenfassung ueber alle Provider.
 *
 * `anyMarketDataConnected` ist die Bedingung, an der die gesamte Pipeline
 * haengt: solange sie falsch ist, gibt es nichts zu entdecken, nichts zu
 * bewerten und nichts zu simulieren.
 */
export interface ProviderFleetStatus {
  readonly reports: readonly ProviderStatusReport[];
  readonly anyMarketDataConnected: boolean;
  readonly anyMarketDataUsable: boolean;
  readonly blockedCount: number;
  readonly notConfiguredCount: number;
  readonly summary: string;
}

export function summarizeFleet(
  reports: readonly ProviderStatusReport[],
): ProviderFleetStatus {
  const market = reports.filter((r) => r.capabilities.includes("TOKEN_MARKET"));
  const anyMarketDataConnected = market.some((r) => r.status === "CONNECTED");
  const anyMarketDataUsable =
    anyMarketDataConnected || market.some((r) => r.status === "DEGRADED");
  const blockedCount = reports.filter((r) => r.status === "BLOCKED").length;
  const notConfiguredCount = reports.filter((r) => r.status === "NOT_CONFIGURED").length;

  return {
    reports,
    anyMarketDataConnected,
    anyMarketDataUsable,
    blockedCount,
    notConfiguredCount,
    summary: anyMarketDataConnected
      ? `${market.filter((r) => r.status === "CONNECTED").length} von ${market.length} Marktdatenquellen verbunden.`
      : blockedCount > 0
        ? `Keine Marktdaten: ${blockedCount} Anbieter vom Netz gesperrt, ${notConfiguredCount} nicht konfiguriert.`
        : "Keine Marktdatenquelle verfuegbar.",
  };
}
