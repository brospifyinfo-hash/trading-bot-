/**
 * Minimale In-Process-Metriken.
 *
 * Bewusst ohne Prometheus-Client in Phase 1: der Registry-Vertrag steht, der
 * Exporter kommt in Phase 18. Wichtig ist, dass die Messpunkte von Anfang an im
 * Code sitzen — nachtraeglich eingezogene Metriken messen immer das Falsche.
 */

export type MetricLabels = Readonly<Record<string, string>>;

export class MetricsRegistry {
  readonly #counters = new Map<string, number>();
  readonly #observations = new Map<string, number[]>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = seriesKey(name, labels);
    const list = this.#observations.get(key) ?? [];
    list.push(value);
    this.#observations.set(key, list);
  }

  counter(name: string, labels: MetricLabels = {}): number {
    return this.#counters.get(seriesKey(name, labels)) ?? 0;
  }

  /** Quantil nach der nearest-rank-Methode. */
  quantile(name: string, q: number, labels: MetricLabels = {}): number | null {
    const values = this.#observations.get(seriesKey(name, labels));
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(q * sorted.length));
    return sorted[rank - 1] ?? null;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counters);
  }
}

function seriesKey(name: string, labels: MetricLabels): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `${name}{${parts.join(",")}}` : name;
}

export const METRICS = {
  tokensDiscovered: "sae_tokens_discovered_total",
  decisionsMade: "sae_decisions_total",
  rejections: "sae_rejections_total",
  providerLatencyMs: "sae_provider_latency_ms",
  executionSlippageBps: "sae_execution_slippage_bps",
  executionDelayMs: "sae_execution_delay_ms",
  circuitBreakerTrips: "sae_circuit_breaker_trips_total",
} as const;
