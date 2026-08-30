import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FixedClock, isMissing, isPresent, providerId } from "@sae/core";
import { ProviderHttpClient } from "../http";
import { TokenBucket } from "../rate-limiter";
import { CircuitBreaker } from "../circuit-breaker";
import { HealthTracker } from "../health";
import { ProviderBudget } from "../budget";

const T0 = new Date("2026-08-30T12:00:00Z");
const SCHEMA = z.object({ value: z.number() });

function makeClient(
  fetchImpl: typeof fetch,
  overrides: { capacity?: number; monthlyLimitUsd?: number } = {},
) {
  const clock = new FixedClock(T0);
  const bucket = new TokenBucket({
    capacity: overrides.capacity ?? 10,
    refillPerSecond: 1,
    clock,
  });
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, clock });
  const health = new HealthTracker({ clock });
  const budget =
    overrides.monthlyLimitUsd === undefined
      ? undefined
      : new ProviderBudget({
          monthlyLimitUsd: overrides.monthlyLimitUsd,
          costPerRequestUsd: 1,
          clock,
        });

  const client = new ProviderHttpClient({
    providerId: providerId("test"),
    clock,
    bucket,
    breaker,
    health,
    ...(budget ? { budget } : {}),
    fetchImpl,
  });
  return { client, clock, bucket, breaker, health, budget };
}

const jsonResponse = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("ProviderHttpClient", () => {
  it("liefert eine Observation mit Quelle und Zeitstempel", async () => {
    const { client } = makeClient(jsonResponse({ value: 42 }));
    const result = await client.request({ url: "https://example.test/x" }, SCHEMA);
    expect(isPresent(result)).toBe(true);
    if (isPresent(result)) {
      expect(result.value).toEqual({ value: 42 });
      expect(result.source).toBe("test");
      expect(result.observedAt).toEqual(T0);
    }
  });

  it("liefert MISSING statt einer Ausnahme, wenn der Anbieter ausfaellt", async () => {
    const { client } = makeClient(jsonResponse({}, 500));
    const result = await client.request({ url: "https://example.test/x" }, SCHEMA);
    expect(isMissing(result)).toBe(true);
    if (isMissing(result)) expect(result.reason).toBe("PROVIDER_DOWN");
  });

  it("unterscheidet 404 als 'Token unbekannt' von einem Ausfall", async () => {
    // Ein unbekannter Token ist kein Anbieterfehler und darf den Breaker nicht
    // in dieselbe Richtung treiben wie ein echter Ausfall.
    const { client } = makeClient(jsonResponse({}, 404));
    const result = await client.request({ url: "https://example.test/x" }, SCHEMA);
    if (isMissing(result)) expect(result.reason).toBe("NO_DATA_FOR_TOKEN");
  });

  it("erkennt 429 als Rate Limit", async () => {
    const { client } = makeClient(jsonResponse({}, 429));
    const result = await client.request({ url: "https://example.test/x" }, SCHEMA);
    if (isMissing(result)) expect(result.reason).toBe("PROVIDER_RATE_LIMITED");
  });

  it("lehnt eine Antwort ab, die nicht zum Schema passt", async () => {
    // Der wichtigste Fall: ein Anbieter aendert sein Format. Ein halb geparstes
    // Objekt mit undefined-Feldern wuerde weiter oben zu Defaultwerten und
    // damit zu Entscheidungen auf erfundener Grundlage.
    const { client } = makeClient(jsonResponse({ value: "keine Zahl" }));
    const result = await client.request({ url: "https://example.test/x" }, SCHEMA);
    expect(isMissing(result)).toBe(true);
    if (isMissing(result)) expect(result.reason).toBe("PARSE_FAILED");
  });

  it("wertet eine Schema-Abweichung als Ausfall des Anbieters", async () => {
    const { client, health } = makeClient(jsonResponse({ value: "falsch" }));
    for (let i = 0; i < 3; i++) await client.request({ url: "https://example.test/x" }, SCHEMA);
    expect(health.state().status).toBe("DOWN");
  });

  it("blockiert bei erschoepftem Kontingent, ohne zu warten", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ value: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(counting, { capacity: 2 });
    await client.request({ url: "https://example.test/x" }, SCHEMA);
    await client.request({ url: "https://example.test/x" }, SCHEMA);
    const third = await client.request({ url: "https://example.test/x" }, SCHEMA);

    expect(calls).toBe(2);
    if (isMissing(third)) expect(third.reason).toBe("PROVIDER_RATE_LIMITED");
  });

  it("fragt nicht mehr an, wenn der Circuit Breaker offen ist", async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(failing);
    for (let i = 0; i < 5; i++) await client.request({ url: "https://example.test/x" }, SCHEMA);
    // Drei Fehlschlaege oeffnen den Breaker; danach wird nicht mehr gesendet.
    expect(calls).toBe(3);
  });

  it("blockiert bei aufgebrauchtem Monatsbudget", async () => {
    const { client } = makeClient(jsonResponse({ value: 1 }), { monthlyLimitUsd: 1 });
    await client.request({ url: "https://example.test/x" }, SCHEMA);
    const second = await client.request({ url: "https://example.test/x" }, SCHEMA);
    expect(isMissing(second)).toBe(true);
    if (isMissing(second)) expect(second.reason).toBe("BUDGET_EXCEEDED");
  });

  it("behandelt einen Abbruch als Timeout", async () => {
    const aborting = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const { client } = makeClient(aborting);
    const result = await client.request({ url: "https://example.test/x" }, SCHEMA);
    if (isMissing(result)) expect(result.reason).toBe("PROVIDER_TIMEOUT");
  });
});
