/**
 * Schutz gegen Geheimnisse im Log.
 *
 * Bewusst als ALLOWLIST und nicht als Blocklist: eine Blocklist schuetzt nur vor
 * den Feldnamen, an die jemand gedacht hat. Bei einem System, das private
 * Schluessel in Reichweite hat, ist das die falsche Richtung — hier darf
 * standardmaessig nichts durch, ausser es steht ausdruecklich auf der Liste.
 */

/** Feldnamen, die im Log erscheinen duerfen. Alles andere wird ersetzt. */
export const LOG_ALLOWLIST: ReadonlySet<string> = new Set([
  "level", "time", "msg", "name", "hostname", "pid", "err", "error", "stack", "type",
  "traceId", "decisionId", "intentId", "positionId", "executionId", "tokenId",
  "strategyVersionId", "scoreEngineVersion", "costModelVersion", "methodVersion",
  "mint", "symbol", "pool", "dex", "route", "signature", "slot",
  "mode", "origin", "side", "state", "fromState", "toState", "kind", "reason", "reasons",
  "provider", "status", "latencyMs", "attempt", "retryable", "policy",
  "score", "finalScore", "subScores", "riskLevel", "dataCompleteness",
  "notionalMinor", "currency", "amountRaw", "priceUsd", "liquidityUsd",
  "slippageBps", "priceImpactBps", "feeBps", "costsMinor", "pnlMinor",
  "count", "durationMs", "queue", "jobId", "role", "version", "url", "method", "statusCode",
]);

export const REDACTED = "[redacted]";

const MAX_DEPTH = 6;

/**
 * Ersetzt alles, was nicht auf der Allowlist steht.
 *
 * Arrays und verschachtelte Objekte werden mitgezogen; die Tiefenbegrenzung
 * verhindert, dass ein zyklisches oder absurd tiefes Objekt den Logger blockiert.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = LOG_ALLOWLIST.has(key) ? redact(v, depth + 1) : REDACTED;
    }
    return out;
  }
  return value;
}
