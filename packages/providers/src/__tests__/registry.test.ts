import { describe, expect, it } from "vitest";
import { providerId } from "@sae/core";
import { CRITICAL_PROVIDER_KINDS, ProviderRegistry } from "../registry";
import type { Provider, ProviderHealthState, ProviderKind } from "../types";

function fakeProvider(
  id: string,
  kind: ProviderKind,
  status: ProviderHealthState["status"],
): Provider {
  return {
    descriptor: { id: providerId(id), kind, verifiedAt: null, docsPath: "" },
    health: () => ({
      status,
      latencyMsP95: null,
      errorRate: 0,
      budgetUsedPct: null,
      lastSuccessAt: null,
      detail: null,
    }),
  };
}

describe("ProviderRegistry", () => {
  it("waehlt den ersten nicht ausgefallenen Anbieter", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("primary", "market", "DOWN"));
    registry.register(fakeProvider("fallback", "market", "HEALTHY"));
    expect(registry.primary("market")?.descriptor.id).toBe("fallback");
  });

  it("akzeptiert einen degradierten Anbieter als besser als keinen", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("only", "market", "DEGRADED"));
    expect(registry.primary("market")?.descriptor.id).toBe("only");
  });

  it("liefert null, wenn alle ausgefallen sind", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("a", "router", "DOWN"));
    expect(registry.primary("router")).toBeNull();
  });

  it("benennt fehlende kritische Kategorien", () => {
    // Genau dieser Aufruf blockiert spaeter den Einstieg: ohne Marktdaten oder
    // Router ist jede Entscheidung wertlos.
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("market", "market", "HEALTHY"));
    expect(registry.unavailableKinds(CRITICAL_PROVIDER_KINDS)).toEqual(["router"]);
  });

  it("zaehlt Social nicht zu den kritischen Kategorien", () => {
    // Fehlendes Social senkt die Datenvollstaendigkeit; fehlende Preise machen
    // die Entscheidung unmoeglich. Der Unterschied ist beabsichtigt.
    expect(CRITICAL_PROVIDER_KINDS).not.toContain("social");
  });

  it("gibt einen Zustandsueberblick fuer das Dashboard", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider("a", "market", "HEALTHY"));
    registry.register(fakeProvider("b", "router", "DEGRADED"));
    expect(registry.snapshot().map((s) => s.status).sort()).toEqual(["DEGRADED", "HEALTHY"]);
  });
});
