import { describe, expect, it } from "vitest";
import { FixedClock, providerId } from "@sae/core";

import {
  classifyFailure,
  combineSources,
  deriveStatus,
  resolveFromChain,
  sourced,
  statusAllowsEntryDecision,
  statusAllowsUse,
  worseTier,
  type ChainMember,
  type ProviderStatus,
  type StatusInputs,
} from "../capability";

const T0 = new Date("2026-08-31T12:00:00Z");
const clock = new FixedClock(T0);

const base: StatusInputs = {
  configured: true,
  lastFailureClass: null,
  hasEverSucceeded: true,
  errorRate: 0,
  budgetExhausted: false,
  breakerOpen: false,
  secondsSinceLastSuccess: 5,
  maxSilenceSeconds: 300,
  degradedErrorRate: 0.2,
};

describe("Fehlerklassifikation", () => {
  it("erkennt eine abgelehnte Proxy-Verbindung als Netzsperre", () => {
    // Der aktuelle Zustand dieses Systems: der Proxy lehnt CONNECT ab, bevor
    // der Anbieter ueberhaupt gefragt wurde.
    expect(
      classifyFailure({ message: "CONNECT api.jup.ag:443 failed with 403" }),
    ).toBe("BLOCKED");
    expect(classifyFailure({ httpStatus: 407 })).toBe("BLOCKED");
  });

  it("trennt nicht erreichbar von gesperrt", () => {
    expect(classifyFailure({ errorCode: "ENOTFOUND" })).toBe("UNAVAILABLE");
    expect(classifyFailure({ errorCode: "ETIMEDOUT" })).toBe("UNAVAILABLE");
    expect(classifyFailure({ httpStatus: 503 })).toBe("UNAVAILABLE");
  });

  it("erkennt Rate Limit und eigene Fehler", () => {
    expect(classifyFailure({ httpStatus: 429 })).toBe("RATE_LIMITED");
    expect(classifyFailure({ httpStatus: 422 })).toBe("BAD_REQUEST");
  });

  it("nennt Unklares nicht gesperrt", () => {
    // Ein faelschlich als BLOCKED gemeldeter Anbieter schickt die Fehlersuche
    // in die falsche Richtung.
    expect(classifyFailure({ message: "irgendwas ist schiefgegangen" })).toBe("UNKNOWN");
  });
});

describe("Statusbildung", () => {
  const cases: ReadonlyArray<[string, Partial<StatusInputs>, ProviderStatus]> = [
    ["ohne Konfiguration", { configured: false }, "NOT_CONFIGURED"],
    ["bei Netzsperre", { lastFailureClass: "BLOCKED" }, "BLOCKED"],
    ["ohne je einen Erfolg", { hasEverSucceeded: false }, "UNAVAILABLE"],
    ["bei offenem Breaker", { breakerOpen: true }, "UNAVAILABLE"],
    ["bei langem Schweigen", { secondsSinceLastSuccess: 600 }, "UNAVAILABLE"],
    ["bei aufgebrauchtem Budget", { budgetExhausted: true }, "DEGRADED"],
    ["bei hoher Fehlerrate", { errorRate: 0.5 }, "DEGRADED"],
    ["im Normalfall", {}, "CONNECTED"],
  ];

  for (const [name, overrides, expected] of cases) {
    it(`liefert ${expected} ${name}`, () => {
      expect(deriveStatus({ ...base, ...overrides })).toBe(expected);
    });
  }

  it("laesst einen alten Erfolg die Netzsperre nicht verdecken", () => {
    expect(
      deriveStatus({ ...base, hasEverSucceeded: true, lastFailureClass: "BLOCKED" }),
    ).toBe("BLOCKED");
  });

  it("unterscheidet nutzbar von entscheidungstragend", () => {
    expect(statusAllowsUse("DEGRADED")).toBe(true);
    // Eine Einstiegsentscheidung traegt nur ein voll funktionierender Anbieter.
    expect(statusAllowsEntryDecision("DEGRADED")).toBe(false);
    for (const s of ["BLOCKED", "UNAVAILABLE", "NOT_CONFIGURED"] as const) {
      expect(statusAllowsUse(s)).toBe(false);
      expect(statusAllowsEntryDecision(s)).toBe(false);
    }
  });
});

describe("Herkunft und Qualitaet", () => {
  it("rechnet die Frische aus Beobachtungs- und Abholzeit", () => {
    const s = sourced({
      value: 42,
      providerId: providerId("p1"),
      tier: "PRIMARY",
      observedAt: new Date(T0.getTime() - 45_000),
      fetchedAt: T0,
    });
    expect(s.freshnessSeconds).toBe(45);
  });

  it("gibt einem zusammengesetzten Wert die schlechteste Stufe", () => {
    // Preis vom Primaeranbieter, Liquiditaet vom Fallback: das Ergebnis ist
    // kein Primaerdatensatz.
    const combined = combineSources({ price: 1, liquidity: 2 }, [
      sourced({
        value: 1,
        providerId: providerId("primary"),
        tier: "PRIMARY",
        observedAt: new Date(T0.getTime() - 5_000),
        fetchedAt: T0,
      }),
      sourced({
        value: 2,
        providerId: providerId("fallback"),
        tier: "FALLBACK",
        observedAt: new Date(T0.getTime() - 120_000),
        fetchedAt: T0,
      }),
    ]);

    expect(combined.effectiveTier).toBe("FALLBACK");
    expect(combined.effectiveFreshnessSeconds).toBe(120);
    expect(combined.contributors).toHaveLength(2);
  });

  it("verlangt mindestens eine Quelle", () => {
    expect(() => combineSources({}, [])).toThrow(/mindestens eine Quelle/);
  });

  it("kennt die Rangfolge der Stufen", () => {
    expect(worseTier("PRIMARY", "SECONDARY")).toBe("SECONDARY");
    expect(worseTier("FALLBACK", "SECONDARY")).toBe("FALLBACK");
    expect(worseTier("PRIMARY", "PRIMARY")).toBe("PRIMARY");
  });
});

describe("Fallback-Kette", () => {
  interface Fake {
    readonly name: string;
    readonly answer: number | null;
    readonly throws?: boolean;
  }

  function member(
    name: string,
    tier: ChainMember<Fake>["tier"],
    status: ProviderStatus,
    answer: number | null,
    throws = false,
  ): ChainMember<Fake> {
    return {
      provider: { name, answer, throws },
      providerId: providerId(name),
      tier,
      status: () => status,
    };
  }

  const fetch = async (p: Fake) => {
    if (p.throws) throw new Error(`${p.name} kaputt`);
    return p.answer === null ? null : { value: p.answer, observedAt: T0 };
  };

  it("nimmt den ersten Anbieter, der liefert", async () => {
    const result = await resolveFromChain({
      members: [
        member("primary", "PRIMARY", "CONNECTED", 100),
        member("secondary", "SECONDARY", "CONNECTED", 200),
      ],
      fetch,
      clock,
    });

    expect(result.kind).toBe("OK");
    if (result.kind === "OK") {
      expect(result.data.value).toBe(100);
      expect(result.data.tier).toBe("PRIMARY");
    }
  });

  it("faellt auf die naechste Stufe zurueck und kennzeichnet sie", async () => {
    const result = await resolveFromChain({
      members: [
        member("primary", "PRIMARY", "BLOCKED", 100),
        member("secondary", "SECONDARY", "CONNECTED", 200),
      ],
      fetch,
      clock,
    });

    expect(result.kind).toBe("OK");
    if (result.kind === "OK") {
      // Der Wert kommt vom Zweitanbieter — und sagt das auch.
      expect(result.data.value).toBe(200);
      expect(result.data.tier).toBe("SECONDARY");
    }
    expect(result.attempts[0]).toMatchObject({ outcome: "SKIPPED_STATUS", detail: "BLOCKED" });
  });

  it("meldet NO_SOURCE als regulaeres Ergebnis", async () => {
    // Der aktuelle Zustand: alles gesperrt.
    const result = await resolveFromChain({
      members: [
        member("primary", "PRIMARY", "BLOCKED", 100),
        member("secondary", "SECONDARY", "NOT_CONFIGURED", 200),
      ],
      fetch,
      clock,
    });

    expect(result.kind).toBe("NO_SOURCE");
    if (result.kind === "NO_SOURCE") {
      expect(result.reason).toMatch(/Kein Anbieter lieferte Daten/);
      expect(result.attempts).toHaveLength(2);
    }
  });

  it("laeuft nach einem Fehler weiter, statt abzubrechen", async () => {
    const result = await resolveFromChain({
      members: [
        member("primary", "PRIMARY", "CONNECTED", null, true),
        member("fallback", "FALLBACK", "CONNECTED", 300),
      ],
      fetch,
      clock,
    });

    expect(result.kind).toBe("OK");
    if (result.kind === "OK") expect(result.data.tier).toBe("FALLBACK");
    expect(result.attempts[0]!.outcome).toBe("ERROR");
    expect(result.attempts[0]!.detail).toMatch(/kaputt/);
  });

  it("kann eingeschraenkte Anbieter ausschliessen", async () => {
    const members = [member("primary", "PRIMARY", "DEGRADED", 100)];
    const lenient = await resolveFromChain({ members, fetch, clock });
    const strict = await resolveFromChain({ members, fetch, clock, allowDegraded: false });

    expect(lenient.kind).toBe("OK");
    // Fuer eine Einstiegsentscheidung reicht DEGRADED nicht.
    expect(strict.kind).toBe("NO_SOURCE");
  });

  it("vermischt nichts: das Ergebnis stammt aus genau einer Quelle", async () => {
    const result = await resolveFromChain({
      members: [
        member("primary", "PRIMARY", "CONNECTED", null),
        member("secondary", "SECONDARY", "CONNECTED", 200),
        member("fallback", "FALLBACK", "CONNECTED", 300),
      ],
      fetch,
      clock,
    });

    expect(result.kind).toBe("OK");
    if (result.kind === "OK") {
      expect(result.data.value).toBe(200);
      expect(result.data.providerId).toBe("secondary");
    }
  });
});
