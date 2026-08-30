import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import {
  DEFAULT_REVALIDATION_LIMITS,
  REVALIDATION_TTL_MS,
  acceptRevalidation,
  revalidate,
  type MarketSnapshot,
} from "../revalidation";

const T0 = new Date("2026-08-30T12:00:00Z");

const snapshot = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  priceUsd: 0.0004,
  liquidityUsd: 120_000,
  finalScore: 84,
  riskLevel: "LOW",
  at: T0,
  ...overrides,
});

const run = (now: Partial<MarketSnapshot>, options: { ageMs?: number } = {}) => {
  const clock = new FixedClock(new Date(T0.getTime() + (options.ageMs ?? 120_000)));
  return revalidate({
    atAlert: snapshot(),
    now: snapshot(now),
    intentCreatedAt: T0,
    clock,
    newRevalidationId: () => "reval-1",
  });
};

describe("revalidate", () => {
  it("laesst einen weitgehend unveraenderten Markt durch", () => {
    const result = run({ priceUsd: 0.00042 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revalidationId).toBe("reval-1");
      expect(result.changes).toHaveLength(4);
    }
  });

  it("zeigt immer einen Diff, auch wenn alles passt", () => {
    // Der Nutzer soll sehen, was sich veraendert hat, nicht nur den aktuellen
    // Stand. Die Frage ist "was ist seit der Mail passiert", nicht "wie sieht es
    // jetzt aus".
    const result = run({ priceUsd: 0.00042 });
    const price = result.changes.find((c) => c.field === "Preis");
    expect(price?.atAlert).toBeTruthy();
    expect(price?.now).toBeTruthy();
    expect(price?.changePct).toBeCloseTo(5, 0);
  });

  it("blockiert einen zu stark gestiegenen Preis", () => {
    // Der Einstieg waere ein anderer als der, der im Alert stand.
    const result = run({ priceUsd: 0.0006 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejectionReasons).toContain("DATA_STALE");
  });

  it("blockiert einen zu stark gefallenen Preis", () => {
    const result = run({ priceUsd: 0.00025 });
    expect(result.ok).toBe(false);
  });

  it("blockiert abgezogene Liquiditaet", () => {
    const result = run({ liquidityUsd: 60_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejectionReasons).toContain("LIQUIDITY_TOO_LOW");
  });

  it("blockiert einen eingebrochenen Score", () => {
    const result = run({ finalScore: 60 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejectionReasons).toContain("FINAL_SCORE_TOO_LOW");
  });

  it("blockiert jede Verschlechterung der Sicherheitsbewertung", () => {
    // Unabhaengig von jeder Schwelle: die Grundlage des Alerts gilt nicht mehr.
    const result = run({ riskLevel: "MEDIUM" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejectionReasons).toContain("SECURITY_CRITICAL");
  });

  it("blockiert CRITICAL auch ohne Verschlechterung", () => {
    const clock = new FixedClock(new Date(T0.getTime() + 60_000));
    const result = revalidate({
      atAlert: snapshot({ riskLevel: "CRITICAL" }),
      now: snapshot({ riskLevel: "CRITICAL" }),
      intentCreatedAt: T0,
      clock,
      newRevalidationId: () => "reval-1",
    });
    expect(result.ok).toBe(false);
  });

  it("blockiert einen zu alten Intent", () => {
    const result = run(
      { priceUsd: 0.0004 },
      { ageMs: DEFAULT_REVALIDATION_LIMITS.maxIntentAgeMs + 1_000 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejectionReasons).toContain("DATA_STALE");
  });

  it("markiert im Diff, welche Aenderung blockiert", () => {
    const result = run({ liquidityUsd: 40_000 });
    const liquidity = result.changes.find((c) => c.field === "Liquiditaet");
    expect(liquidity?.blocking).toBe(true);
    expect(result.changes.find((c) => c.field === "Score")?.blocking).toBe(false);
  });

  it("nennt bei Ablehnung eine verstaendliche Begruendung", () => {
    const result = run({ liquidityUsd: 10_000 });
    if (!result.ok) expect(result.message).toContain("Marktbedingungen");
  });

  it("gibt der Revalidierung eine kurze Gueltigkeit", () => {
    const clock = new FixedClock(new Date(T0.getTime() + 60_000));
    const result = revalidate({
      atAlert: snapshot(),
      now: snapshot(),
      intentCreatedAt: T0,
      clock,
      newRevalidationId: () => "reval-1",
    });
    if (result.ok) {
      expect(result.validUntil.getTime() - clock.now().getTime()).toBe(REVALIDATION_TTL_MS);
    }
  });
});

describe("acceptRevalidation", () => {
  it("akzeptiert eine frische, passende Revalidierung", () => {
    const clock = new FixedClock(T0);
    const result = acceptRevalidation({
      revalidationId: "reval-1",
      expectedId: "reval-1",
      validUntil: new Date(T0.getTime() + 30_000),
      clock,
    });
    expect(result.ok).toBe(true);
  });

  it("lehnt eine fremde Revalidierung ab", () => {
    const result = acceptRevalidation({
      revalidationId: "reval-2",
      expectedId: "reval-1",
      validUntil: new Date(T0.getTime() + 30_000),
      clock: new FixedClock(T0),
    });
    expect(result.ok).toBe(false);
  });

  it("lehnt eine abgelaufene Revalidierung ab", () => {
    // Die dritte von drei unabhaengigen Pruefungen. Zwischen Bestaetigungsseite
    // und Worker vergehen Sekunden — und in Sekunden passiert bei Memecoins genug.
    const result = acceptRevalidation({
      revalidationId: "reval-1",
      expectedId: "reval-1",
      validUntil: new Date(T0.getTime() - 1_000),
      clock: new FixedClock(T0),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("abgelaufen");
  });
});
