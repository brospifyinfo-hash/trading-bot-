import { describe, expect, it } from "vitest";
import { FixedClock, providerId, tokenId } from "@sae/core";
import { sourced, type Sourced } from "@sae/providers";

import {
  InMemorySeenKeys,
  decideIngest,
  markIngested,
  snapshotIngestKey,
  snapshotSupportsEntry,
  type MarketObservation,
} from "../ingestion";

const T0 = new Date("2026-08-31T12:00:00Z");
const TOKEN = tokenId("token-1");
const market: MarketObservation = {
  priceUsd: 0.00042,
  liquidityUsd: 120_000,
  marketCapUsd: 1_800_000,
  volume24hUsd: 450_000,
  holders: 900,
};

function observation(
  overrides: {
    ageSeconds?: number;
    tier?: Sourced<MarketObservation>["tier"];
    provider?: string;
    value?: Partial<MarketObservation>;
  } = {},
): Sourced<MarketObservation> {
  const age = overrides.ageSeconds ?? 10;
  return sourced({
    value: { ...market, ...overrides.value },
    providerId: providerId(overrides.provider ?? "dexscreener"),
    tier: overrides.tier ?? "PRIMARY",
    observedAt: new Date(T0.getTime() - age * 1_000),
    fetchedAt: T0,
  });
}

describe("Aufnahme von Marktdaten", () => {
  it("nimmt eine frische Beobachtung mit Herkunft auf", async () => {
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: observation(),
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });

    expect(decision.kind).toBe("ACCEPT");
    if (decision.kind === "ACCEPT") {
      expect(decision.candidate.provenance.providerId).toBe("dexscreener");
      expect(decision.candidate.provenance.tier).toBe("PRIMARY");
      expect(decision.candidate.provenance.freshnessSeconds).toBe(10);
    }
  });

  it("erzeugt ohne Quelle keinen Snapshot", async () => {
    // Die technische Fassung von „ein Datenausfall darf kein gueltiges
    // Handelssignal erzeugen": kein letzter bekannter Wert, kein null, keiner.
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: null,
      noSourceReason: "Alle Anbieter gesperrt.",
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });

    expect(decision.kind).toBe("REJECT_NO_SOURCE");
    if (decision.kind === "REJECT_NO_SOURCE") expect(decision.reason).toMatch(/gesperrt/);
  });

  it("weist eine Beobachtung aus der Zukunft ab", async () => {
    // Uhrendrift beim Anbieter wuerde sonst Daten in die Historie schreiben,
    // die es zum Entscheidungszeitpunkt noch nicht gab.
    const future = sourced({
      value: market,
      providerId: providerId("p"),
      tier: "PRIMARY",
      observedAt: new Date(T0.getTime() + 60_000),
      fetchedAt: T0,
    });
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: future,
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });

    expect(decision.kind).toBe("REJECT_FUTURE");
  });

  it("duldet leichte Uhrendrift", async () => {
    const slightlyAhead = sourced({
      value: market,
      providerId: providerId("p"),
      tier: "PRIMARY",
      observedAt: new Date(T0.getTime() + 2_000),
      fetchedAt: T0,
    });
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: slightlyAhead,
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });
    expect(decision.kind).toBe("ACCEPT");
  });

  it("weist eine zu alte Beobachtung als aktuellen Stand ab", async () => {
    const decision = await decideIngest({
      tokenId: TOKEN,
      sourcedValue: observation({ ageSeconds: 600 }),
      seen: new InMemorySeenKeys(),
      clock: new FixedClock(T0),
    });
    expect(decision.kind).toBe("REJECT_STALE");
  });

  it("weist einen unbrauchbaren Preis ab", async () => {
    for (const price of [0, -1, Number.NaN]) {
      const decision = await decideIngest({
        tokenId: TOKEN,
        sourcedValue: observation({ value: { priceUsd: price } }),
        seen: new InMemorySeenKeys(),
        clock: new FixedClock(T0),
      });
      expect(decision.kind).toBe("REJECT_INVALID");
    }
  });
});

describe("Idempotenz der Pipeline", () => {
  it("erzeugt aus demselben Ereignis keinen zweiten Snapshot", async () => {
    const seen = new InMemorySeenKeys();
    const clock = new FixedClock(T0);
    const value = observation();

    const first = await decideIngest({ tokenId: TOKEN, sourcedValue: value, seen, clock });
    expect(first.kind).toBe("ACCEPT");
    if (first.kind === "ACCEPT") await markIngested(seen, first.candidate);

    const second = await decideIngest({ tokenId: TOKEN, sourcedValue: value, seen, clock });
    expect(second.kind).toBe("DUPLICATE");
    expect(seen.size).toBe(1);
  });

  it("ignoriert Millisekundenunterschiede desselben Datenpunkts", () => {
    // Zwei Abrufe derselben Anbieterbeobachtung unterscheiden sich sonst durch
    // Millisekunden und erzeugen zwei Snapshots desselben Punkts.
    const a = snapshotIngestKey({
      tokenId: TOKEN,
      observedAt: new Date(T0.getTime() + 120),
      providerId: providerId("p"),
    });
    const b = snapshotIngestKey({
      tokenId: TOKEN,
      observedAt: new Date(T0.getTime() + 880),
      providerId: providerId("p"),
    });
    expect(a).toBe(b);
  });

  it("unterscheidet Beobachtungen verschiedener Anbieter", () => {
    const a = snapshotIngestKey({ tokenId: TOKEN, observedAt: T0, providerId: providerId("a") });
    const b = snapshotIngestKey({ tokenId: TOKEN, observedAt: T0, providerId: providerId("b") });
    expect(a).not.toBe(b);
  });
});

describe("Was eine Einstiegsentscheidung tragen darf", () => {
  it("laesst Primaerdaten zu", () => {
    expect(
      snapshotSupportsEntry({
        providerId: providerId("p"),
        tier: "PRIMARY",
        freshnessSeconds: 5,
        contributors: [],
      }).allowed,
    ).toBe(true);
  });

  it("laesst Fallback-Daten nicht zu", () => {
    // Sie duerfen beobachtet und gespeichert werden — sie tragen nur keine
    // Entscheidung, bei der es um Geld geht.
    const verdict = snapshotSupportsEntry({
      providerId: providerId("p"),
      tier: "FALLBACK",
      freshnessSeconds: 5,
      contributors: [],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/Fallback/);
  });

  it("laesst veraltete Daten nicht zu", () => {
    expect(
      snapshotSupportsEntry({
        providerId: providerId("p"),
        tier: "PRIMARY",
        freshnessSeconds: 900,
        contributors: [],
      }).allowed,
    ).toBe(false);
  });
});
