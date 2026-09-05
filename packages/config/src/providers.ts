import { z } from "zod";

/**
 * Konfiguration der Datenquellen.
 *
 * Hier stehen ausschliesslich Basis-URLs und Zugangsdaten — **keine
 * Endpunktpfade**. Der Grund ist keine Vorliebe: einen Pfad zu konfigurieren
 * hiesse, ihn zu kennen, und bekannt ist derzeit genau einer (Jupiter, aus
 * seiner eigenen OpenAPI-Spezifikation geholt). Fuer alle anderen waere jeder
 * Pfad hier eine Erfindung, und eine Erfindung, die konfigurierbar aussieht,
 * ist gefaehrlicher als eine fehlende Datei.
 *
 * Ein Anbieter ohne Eintrag ist `NOT_CONFIGURED` — kein Fehler, sondern eine
 * Feststellung. Genau das ist der Zustand, den das Dashboard anzeigen soll.
 */

const nonEmpty = z.string().trim().min(1);

export const providerEnvSchema = z.object({
  /** Reihenfolge der Marktdatenquellen: erste = PRIMARY, zweite = SECONDARY, Rest = FALLBACK. */
  MARKET_DATA_PRIORITY: nonEmpty.optional(),

  DEXSCREENER_BASE_URL: nonEmpty.url().optional(),

  BIRDEYE_BASE_URL: nonEmpty.url().optional(),
  BIRDEYE_API_KEY: nonEmpty.optional(),

  JUPITER_BASE_URL: nonEmpty.url().optional(),

  HELIUS_BASE_URL: nonEmpty.url().optional(),
  HELIUS_API_KEY: nonEmpty.optional(),

  RUGCHECK_BASE_URL: nonEmpty.url().optional(),
});

export type ProviderEnv = z.infer<typeof providerEnvSchema>;

export type KnownProviderId = "dexscreener" | "birdeye" | "jupiter" | "helius" | "rugcheck";

export interface ProviderConfigEntry {
  readonly id: KnownProviderId;
  readonly kind: "market" | "router" | "security" | "holders";
  readonly capabilities: readonly string[];
  readonly baseUrl: string | null;
  readonly requiresApiKey: boolean;
  readonly apiKeyPresent: boolean;
  /** Vollstaendig konfiguriert und damit ueberhaupt ansprechbar. */
  readonly configured: boolean;
  /**
   * Ob ein geprueftes Adapter-Modul existiert.
   *
   * Ohne Adapter kann der Anbieter nicht abgefragt werden, auch wenn er
   * konfiguriert ist. Getrennt gefuehrt, damit im Dashboard erkennbar bleibt,
   * ob eine Zugangsdatenfrage oder eine Implementierungsfrage vorliegt.
   */
  readonly adapterImplemented: boolean;
}

export function readProviderConfig(env: ProviderEnv): readonly ProviderConfigEntry[] {
  const entries: ProviderConfigEntry[] = [
    {
      id: "dexscreener",
      kind: "market",
      capabilities: ["TOKEN_MARKET", "TOKEN_DISCOVERY"],
      baseUrl: env.DEXSCREENER_BASE_URL ?? null,
      requiresApiKey: false,
      apiKeyPresent: true,
      configured: env.DEXSCREENER_BASE_URL !== undefined,
      // Seit 2026-09-03 geprueft: Response-Vertrag aus einer echten Antwort
      // abgeleitet (zodContract mit verified: true), Adapter an die Kette
      // angeschlossen. Siehe docs/providers/dexscreener.md und
      // apps/worker/src/pipeline/market-adapters.ts.
      adapterImplemented: true,
    },
    {
      id: "birdeye",
      kind: "market",
      capabilities: ["TOKEN_MARKET", "PRICE_HISTORY"],
      baseUrl: env.BIRDEYE_BASE_URL ?? null,
      requiresApiKey: true,
      apiKeyPresent: env.BIRDEYE_API_KEY !== undefined,
      configured: env.BIRDEYE_BASE_URL !== undefined && env.BIRDEYE_API_KEY !== undefined,
      adapterImplemented: false,
    },
    {
      id: "jupiter",
      kind: "router",
      capabilities: ["ROUTE_QUOTE", "SWAP_TRANSACTION"],
      baseUrl: env.JUPITER_BASE_URL ?? null,
      requiresApiKey: false,
      apiKeyPresent: true,
      configured: env.JUPITER_BASE_URL !== undefined,
      // Einziger Anbieter mit einem gegen die eigene Spezifikation geprueften
      // Adapter. Siehe docs/providers/jupiter.md.
      adapterImplemented: true,
    },
    {
      id: "helius",
      kind: "holders",
      capabilities: ["HOLDER_DISTRIBUTION"],
      baseUrl: env.HELIUS_BASE_URL ?? null,
      requiresApiKey: true,
      apiKeyPresent: env.HELIUS_API_KEY !== undefined,
      configured: env.HELIUS_BASE_URL !== undefined && env.HELIUS_API_KEY !== undefined,
      adapterImplemented: false,
    },
    {
      id: "rugcheck",
      kind: "security",
      capabilities: ["SECURITY_REPORT"],
      baseUrl: env.RUGCHECK_BASE_URL ?? null,
      requiresApiKey: false,
      apiKeyPresent: true,
      configured: env.RUGCHECK_BASE_URL !== undefined,
      adapterImplemented: false,
    },
  ];
  return entries;
}

export type PriorityTier = "PRIMARY" | "SECONDARY" | "FALLBACK";

/**
 * Ordnet die Marktdatenquellen den Stufen zu.
 *
 * Reihenfolge aus der Konfiguration, nicht aus dem Code: ein Anbieterwechsel
 * darf keine Codeaenderung sein. Nicht genannte Anbieter landen auf FALLBACK —
 * nicht ausgeschlossen, aber auch nicht entscheidungstragend.
 */
export function marketDataPriority(
  env: ProviderEnv,
  available: readonly KnownProviderId[],
): ReadonlyMap<KnownProviderId, PriorityTier> {
  const named = (env.MARKET_DATA_PRIORITY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as KnownProviderId[];

  const result = new Map<KnownProviderId, PriorityTier>();
  named.forEach((id, index) => {
    if (!available.includes(id)) return;
    result.set(id, index === 0 ? "PRIMARY" : index === 1 ? "SECONDARY" : "FALLBACK");
  });
  for (const id of available) {
    if (!result.has(id)) result.set(id, "FALLBACK");
  }
  return result;
}
