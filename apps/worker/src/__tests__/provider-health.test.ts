import { describe, expect, it } from "vitest";
import { summarizeFleet, type ProviderStatusReport } from "@sae/providers";

import { buildStatusReports, sampleProviderHealth } from "../roles/provider-health";

/**
 * Was der Worker meldet, wenn nichts konfiguriert ist.
 *
 * Das ist kein Randfall, sondern der Auslieferungszustand — und die Meldung
 * muss den Unterschied zwischen „nichts hinterlegt" und „ausgefallen" treffen.
 */

const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
} satisfies NodeJS.ProcessEnv;

describe("Provider-Statusbericht", () => {
  it("meldet ohne Konfiguration alles als NOT_CONFIGURED", () => {
    const reports = buildStatusReports(BASE);
    expect(reports.every((r) => r.status === "NOT_CONFIGURED")).toBe(true);
    expect(summarizeFleet(reports).anyMarketDataConnected).toBe(false);
  });

  it("nennt fehlende Zugangsdaten getrennt von fehlender URL", () => {
    const reports = buildStatusReports({
      ...BASE,
      BIRDEYE_BASE_URL: "https://example.invalid",
    });
    const birdeye = reports.find((r) => r.providerId === "birdeye")!;
    expect(birdeye.detail).toMatch(/Zugangsschluessel fehlt/);
  });

  it("unterscheidet konfiguriert-ohne-Adapter von nicht konfiguriert", () => {
    // Sonst sucht jemand den Fehler bei den Zugangsdaten, obwohl das
    // Adapter-Modul fehlt.
    // Helius steht fuer diesen Fall: konfiguriert, aber ohne geprueftes
    // Response-Schema. DexScreener taugt seit dem 2026-09-03 nicht mehr als
    // Beispiel — sein Vertrag ist gegen eine echte Antwort geprueft.
    const reports = buildStatusReports({
      ...BASE,
      HELIUS_BASE_URL: "https://example.invalid",
      HELIUS_API_KEY: "irrelevant",
    });
    const helius = reports.find((r) => r.providerId === "helius")!;
    expect(helius.detail).toMatch(/kein geprueftes Adapter-Modul/);
  });

  it("behauptet fuer keinen Anbieter einen Erfolg", () => {
    // Es wurde nichts abgefragt, also gibt es nichts zu melden — und
    // insbesondere keine Frische.
    for (const report of buildStatusReports(BASE)) {
      expect(report.lastSuccessAt).toBeNull();
      expect(report.dataFreshnessSeconds).toBeNull();
      expect(report.latencyMsP95).toBeNull();
    }
  });

  it("fuehrt die Faehigkeiten je Anbieter mit", () => {
    const reports = buildStatusReports(BASE);
    const jupiter = reports.find((r) => r.providerId === "jupiter")!;
    expect(jupiter.capabilities).toContain("ROUTE_QUOTE");
    expect(jupiter.kind).toBe("router");
  });
});

describe("Der Zustand kommt jetzt aus einer echten Abfrage", () => {
  /**
   * Bis zu dieser Aenderung meldete der Dienst fuer einen konfigurierten
   * Anbieter mit Adapter immer `UNAVAILABLE` — „noch nicht abgefragt". Da
   * `statusAllowsUse` nur CONNECTED und DEGRADED durchlaesst, haette die Kette
   * DexScreener nie gefragt, egal wie gesund er war.
   */

  const CONFIGURED = { DEXSCREENER_BASE_URL: "https://api.example.invalid" };

  /** Ein Speicher, der nur mitschreibt. */
  function fakeStore() {
    const written: ProviderStatusReport[][] = [];
    return {
      written,
      store: {
        record: async (reports: readonly ProviderStatusReport[]) => {
          written.push([...reports]);
          return reports.length;
        },
      } as never,
    };
  }

  async function messen(
    respond: { status?: number; body?: string } | { throws: Error },
  ): Promise<ProviderStatusReport> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      if ("throws" in respond) throw respond.throws;
      const status = respond.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => respond.body ?? "[]",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { written, store } = fakeStore();
    try {
      await sampleProviderHealth({ env: CONFIGURED, store, at: new Date("2026-09-05T12:00:00Z") });
    } finally {
      globalThis.fetch = original;
    }
    return written[0]!.find((r) => String(r.providerId) === "dexscreener")!;
  }

  it("meldet CONNECTED bei einer lesbaren Antwort", async () => {
    const r = await messen({ body: "[]" });
    expect(r.status).toBe("CONNECTED");
    expect(r.lastSuccessAt).not.toBeNull();
    expect(r.lastFailureAt).toBeNull();
    expect(r.latencyMsP95).not.toBeNull();
  });

  it("meldet BLOCKED, wenn jemand uns nicht durchlaesst", async () => {
    const r = await messen({ status: 403, body: "nope" });
    expect(r.status).toBe("BLOCKED");
    expect(r.lastSuccessAt).toBeNull();
    expect(r.lastFailureReason).toContain("BLOCKED");
  });

  it("meldet DEGRADED bei Drosselung — die kommt wieder", async () => {
    expect((await messen({ status: 429, body: "slow down" })).status).toBe("DEGRADED");
  });

  it("meldet UNAVAILABLE bei einem Serverfehler", async () => {
    expect((await messen({ status: 503, body: "down" })).status).toBe("UNAVAILABLE");
  });

  it("meldet UNAVAILABLE bei einer unlesbaren Antwort", async () => {
    // Erreichbar und unbrauchbar. DEGRADED waere hier die Falle: die Kette
    // wuerde ihn weiter fragen, und jede Antwort waere wieder unlesbar.
    const r = await messen({ body: '[{"chainId":"solana"}]' });
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.detail).toContain("nicht lesbar");
  });

  it("traegt einen erfolgreichen Abruf auch in die Bereitschaftstabelle ein", async () => {
    // Anlass: /api/diagnostics/providers meldete in DERSELBEN Antwort
    // `dexscreener: CONNECTED` und `headline: "NO PROVIDER CONFIGURED"`.
    // Die Messreihe lag in provider_status_samples, die Ueberschrift kam aus
    // provider_capability_status — und dort schrieben nur die
    // Smoke-Test-Skripte, die niemand ausfuehrt.
    const declared: unknown[] = [];
    const smoke: { httpStatus: number; schemaVerified: boolean }[] = [];
    const readiness = {
      declare: async (i: unknown) => {
        declared.push(i);
      },
      recordSmokeTest: async (i: { httpStatus: number; schemaVerified: boolean }) => {
        smoke.push(i);
        return null;
      },
    } as never;

    const { store } = fakeStore();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => "[]" }) as unknown as Response) as never;
    try {
      await sampleProviderHealth({ env: CONFIGURED, store, readiness });
    } finally {
      globalThis.fetch = original;
    }

    expect(declared).toHaveLength(1);
    expect(smoke).toHaveLength(1);
    expect(smoke[0]?.httpStatus).toBe(200);
    // Der Vertrag stammt aus einer echten Antwort — ohne ihn bliebe der
    // Anbieter unterhalb CAPABILITY_READY.
    expect(smoke[0]?.schemaVerified).toBe(true);
  });

  it("traegt fuer einen nicht konfigurierten Anbieter nichts ein", async () => {
    const declared: unknown[] = [];
    const readiness = {
      declare: async (i: unknown) => {
        declared.push(i);
      },
      recordSmokeTest: async () => null,
    } as never;
    const { store } = fakeStore();
    await sampleProviderHealth({ env: {}, store, readiness });
    expect(declared).toHaveLength(0);
  });

  it("fragt einen nicht konfigurierten Anbieter gar nicht erst", async () => {
    const { written, store } = fakeStore();
    const original = globalThis.fetch;
    let gefragt = false;
    globalThis.fetch = (async () => {
      gefragt = true;
      return { ok: true, status: 200, text: async () => "[]" } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await sampleProviderHealth({ env: {}, store });
    } finally {
      globalThis.fetch = original;
    }
    expect(gefragt).toBe(false);
    const dex = written[0]!.find((r) => String(r.providerId) === "dexscreener")!;
    expect(dex.status).toBe("NOT_CONFIGURED");
  });
});
