import { providerId, type Clock, type ProviderId } from "@sae/core";
import {
  marketDataPriority,
  readProviderConfig,
  type KnownProviderId,
  type ProviderEnv,
} from "@sae/config";
import {
  resolveFromChain,
  type ChainMember,
  type ChainResult,
  type ProviderCapability,
  type ProviderStatus,
  type SourceTier,
} from "@sae/providers";

/**
 * Baut die Anbieterkette aus der Konfiguration.
 *
 * Bis hierher war `resolveFromChain` eine Funktion ohne Aufrufstelle — die
 * Kette existierte, aber niemand baute sie. Das ist der Unterschied zwischen
 * „vorbereitet" und „verdrahtet", und er ist genau die Art Luecke, die man
 * spaeter fuer eine Datenquellenfrage haelt.
 *
 * Zwei Festlegungen:
 *
 * 1. **Die Reihenfolge kommt aus `MARKET_DATA_PRIORITY`, nicht aus dem Code.**
 *    Ein Anbieterwechsel darf keine Codeaenderung sein.
 * 2. **Ein Anbieter ohne geprueftes Adapter-Modul kommt nicht in die Kette.**
 *    Er waere sonst ein Mitglied, das bei jeder Abfrage scheitert — und der
 *    Fehlschlag saehe aus wie ein Anbieterproblem statt wie eine fehlende
 *    Implementierung.
 */

/** Ein Adapter, der einen Anbieter tatsaechlich abfragen kann. */
export interface MarketDataAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: readonly ProviderCapability[];
  /** `null` = der Anbieter kennt den Token nicht. Kein Ersatzwert. */
  fetchMarket(mint: string): Promise<{ value: MarketFields; observedAt: Date } | null>;
}

export interface MarketFields {
  readonly priceUsd: number;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly holders: number | null;
}

export interface ChainBuildInput {
  readonly env: ProviderEnv;
  /** Verfuegbare Adapter, nach Anbieter. Fehlt einer, faellt der Anbieter raus. */
  readonly adapters: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
  /** Aktueller Zustand je Anbieter, aus dem Health-Tracking. */
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
}

export interface ChainBuildResult {
  readonly members: readonly ChainMember<MarketDataAdapter>[];
  /** Anbieter, die konfiguriert sind, aber keinen Adapter haben. */
  readonly configuredWithoutAdapter: readonly KnownProviderId[];
  /** Anbieter, die einen Adapter haetten, aber nicht konfiguriert sind. */
  readonly adapterWithoutConfig: readonly KnownProviderId[];
  readonly note: string;
}

export function buildMarketDataChain(input: ChainBuildInput): ChainBuildResult {
  const entries = readProviderConfig(input.env).filter((e) => e.kind === "market");

  const configured = entries.filter((e) => e.configured).map((e) => e.id);
  const tiers = marketDataPriority(input.env, configured);

  const members: ChainMember<MarketDataAdapter>[] = [];
  const configuredWithoutAdapter: KnownProviderId[] = [];
  const adapterWithoutConfig: KnownProviderId[] = [];

  for (const entry of entries) {
    const adapter = input.adapters.get(entry.id);
    if (entry.configured && adapter === undefined) {
      configuredWithoutAdapter.push(entry.id);
      continue;
    }
    if (!entry.configured) {
      if (adapter !== undefined) adapterWithoutConfig.push(entry.id);
      continue;
    }
    members.push({
      provider: adapter!,
      providerId: providerId(entry.id),
      tier: tiers.get(entry.id) ?? "FALLBACK",
      status: () => input.statusOf(entry.id),
    });
  }

  // Nach Stufe sortieren: PRIMARY zuerst. Die Reihenfolge in der Kette IST die
  // Prioritaet — sie darf nicht davon abhaengen, in welcher Reihenfolge die
  // Konfiguration gelesen wurde.
  const order: Record<SourceTier, number> = { PRIMARY: 0, SECONDARY: 1, FALLBACK: 2 };
  members.sort((a, b) => order[a.tier] - order[b.tier]);

  return {
    members,
    configuredWithoutAdapter,
    adapterWithoutConfig,
    note:
      members.length === 0
        ? configuredWithoutAdapter.length > 0
          ? `Kein Kettenmitglied: ${configuredWithoutAdapter.join(", ")} konfiguriert, aber ohne geprueftes Adapter-Modul.`
          : "Kein Kettenmitglied: keine Marktdatenquelle konfiguriert."
        : `${members.length} Kettenmitglied(er): ${members.map((m) => `${m.providerId}=${m.tier}`).join(", ")}.`,
  };
}

/**
 * Fragt die Kette nach Marktdaten eines Tokens.
 *
 * Duenne Huelle um `resolveFromChain` — der Zweck ist, dass es genau eine
 * Aufrufstelle gibt und die Kette nicht an mehreren Orten unterschiedlich
 * zusammengesetzt wird.
 */
export async function fetchMarketFromChain(input: {
  readonly chain: ChainBuildResult;
  readonly mint: string;
  readonly clock: Clock;
  /** Fuer eine Einstiegsentscheidung: `false`. Fuer die Historie: `true`. */
  readonly allowDegraded: boolean;
}): Promise<ChainResult<MarketFields>> {
  return resolveFromChain<MarketDataAdapter, MarketFields>({
    members: input.chain.members,
    clock: input.clock,
    allowDegraded: input.allowDegraded,
    fetch: (adapter) => adapter.fetchMarket(input.mint),
  });
}
