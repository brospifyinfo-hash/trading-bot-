import { isBase58Address, mint as toMint, type Clock, type Mint } from "@sae/core";
import type { KnownProviderId, ProviderEnv } from "@sae/config";
import {
  DEFAULT_MARKET_SELECTION,
  selectMarket,
  type MarketCandidate,
  type MarketDataAdapter,
  type MarketFields,
} from "@sae/pipeline";
import { DexScreenerMarketAdapter, type DexScreenerMarket } from "@sae/providers";

/**
 * Die Stelle, an der aus einem Anbieter ein Kettenmitglied wird.
 *
 * Bis hierher war `HandlerDeps.adapters` immer leer — `?? new Map()` in jedem
 * Aufruf. Die Kette wurde gebaut, hatte null Mitglieder und meldete
 * zuverlaessig `NO_SOURCE`. Das war korrekt und nutzlos zugleich: das System
 * hat nie etwas erfunden, aber auch nie etwas abgerufen.
 *
 * Zwei Uebersetzungen passieren hier, und beide sind der Grund, warum diese
 * Datei existiert und nicht der Adapter selbst:
 *
 * 1. **Viele Maerkte zu einem.** `fetchMarkets` liefert alle Pools eines
 *    Tokens. Die Kette will genau einen. Welcher das ist, entscheidet
 *    `selectMarket` — nachvollziehbar und deterministisch, nicht durch
 *    `markets[0]`.
 * 2. **Kein Anbieterzeitstempel.** DexScreener liefert keinen. Das wird hier
 *    als `observedAt: null` weitergereicht und NICHT durch den Abrufzeitpunkt
 *    ersetzt. Die Folge — `freshnessSeconds: null`, also keine
 *    Einstiegsentscheidung — ist eine Eigenschaft der Quelle und soll sichtbar
 *    bleiben.
 */

/**
 * Quote-Assets mit belastbarem USD-Anker.
 *
 * Ein Memecoin-gegen-Memecoin-Pool hat keinen verlaesslichen Dollarpreis:
 * beide Seiten bewegen sich, und der gemeldete Wert haengt an der Bewertung
 * der Gegenseite.
 */
export const USD_ANCHOR_QUOTE_MINTS: readonly string[] = [
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
];

export interface MarketAdapterDeps {
  readonly env: ProviderEnv;
  readonly clock: Clock;
}

/**
 * Baut die Adapter, die es tatsaechlich gibt.
 *
 * Nur Anbieter mit geprueftem Response-Vertrag kommen hier hinein. Ob sie
 * danach in der Kette landen, entscheidet `buildMarketDataChain` anhand der
 * Konfiguration — ein Anbieter ohne `*_BASE_URL` faellt dort heraus, und das
 * ist die richtige Stelle dafuer.
 */
export function buildMarketAdapters(
  deps: MarketAdapterDeps,
): ReadonlyMap<KnownProviderId, MarketDataAdapter> {
  const map = new Map<KnownProviderId, MarketDataAdapter>();
  map.set("dexscreener", dexScreenerChainAdapter(deps));
  return map;
}

function dexScreenerChainAdapter(deps: MarketAdapterDeps): MarketDataAdapter {
  const inner = new DexScreenerMarketAdapter({
    clock: deps.clock,
    ...(deps.env.DEXSCREENER_BASE_URL !== undefined
      ? { baseUrl: deps.env.DEXSCREENER_BASE_URL }
      : {}),
  });

  return {
    providerId: inner.providerId,
    capabilities: inner.capabilities,

    async fetchMarket(rawMint: string): Promise<{
      readonly value: MarketFields;
      readonly observedAt: Date | null;
    } | null> {
      // Marktdaten sind ungeprueft eingehende Daten, und die angefragte
      // Adresse kommt aus einem Auftrag in der Queue. Beides wird geprueft,
      // bevor es irgendetwas ausloest.
      if (!isBase58Address(rawMint)) return null;
      const wanted = toMint(rawMint);

      const outcome = await inner.fetchMarkets([rawMint]);
      // NO_DATA, FAILED und SCHEMA_REJECTED fuehren alle zu `null`: kein
      // Marktwert. Die Unterscheidung dazwischen gehoert in die
      // Provider-Health und ist dort bereits festgehalten — hier wuerde sie zu
      // einem Ersatzwert verleiten.
      if (outcome.kind !== "OK") return null;

      // Die Zuordnung Pool-Adresse -> Rohdatensatz, damit nach der Auswahl
      // Felder verfuegbar bleiben, die fuer die Auswahl selbst keine Rolle
      // spielen (Marktkapitalisierung, FDV).
      const byPool = new Map<string, DexScreenerMarket>();
      const candidates: MarketCandidate[] = [];
      for (const m of outcome.markets) {
        const candidate = toCandidate(m);
        if (candidate === null) continue;
        byPool.set(m.pairAddress, m);
        candidates.push(candidate);
      }

      const selection = selectMarket({
        mint: wanted,
        candidates,
        now: deps.clock.now(),
        settings: {
          ...DEFAULT_MARKET_SELECTION,
          allowedQuoteMints: USD_ANCHOR_QUOTE_MINTS as readonly Mint[],
          // Historienpfad: DexScreener liefert keinen Beobachtungszeitpunkt.
          // Der Snapshot traegt trotzdem unseren eigenen PIT-Stempel, und
          // ohne diese Ausnahme entstuende nie eine Zeitreihe.
          requireProviderTimestamp: false,
        },
      });

      const chosen = selection.chosen;
      if (chosen === null) return null;

      // Ohne Preis kein Marktwert. `MarketFields.priceUsd` ist bewusst nicht
      // nullable — ein Datensatz ohne Preis ist kein Marktdatensatz.
      if (chosen.priceUsd === null) return null;

      const raw = byPool.get(chosen.poolAddress);
      return {
        value: {
          priceUsd: chosen.priceUsd,
          liquidityUsd: chosen.liquidityUsd,
          // In der geprueften Antwort fehlte `marketCap`. Fehlt es weiterhin,
          // bleibt es `null` — NOT_AVAILABLE, nicht 0.
          marketCapUsd: raw?.marketCapUsd ?? null,
          volume24hUsd: chosen.volume24hUsd,
          // DexScreener liefert keine Halterzahl.
          holders: null,
        },
        observedAt: null,
      };
    },
  };
}

/**
 * Ein Anbieter-Datensatz als Kandidat — oder `null`, wenn er nicht taugt.
 *
 * Verworfen wird, was die Adressen nicht bestehen laesst. Eine Pool- oder
 * Mint-Adresse, die keine Base58-Adresse ist, kommt entweder aus einem Fehler
 * des Anbieters oder aus etwas Schlimmerem; in beiden Faellen hat sie in einer
 * Auswahl nichts verloren.
 */
function toCandidate(m: DexScreenerMarket): MarketCandidate | null {
  if (!isBase58Address(m.pairAddress)) return null;
  if (!isBase58Address(m.baseMint)) return null;
  if (!isBase58Address(m.quoteMint)) return null;

  return {
    poolAddress: m.pairAddress as never,
    dex: m.dexId.toLowerCase(),
    baseMint: toMint(m.baseMint),
    quoteMint: toMint(m.quoteMint),
    priceUsd: m.priceUsd,
    liquidityUsd: m.liquidityUsd,
    volume24hUsd: m.volumeUsd.h24,
    buyCount24h: m.txns.h24?.buys ?? null,
    sellCount24h: m.txns.h24?.sells ?? null,
    pairCreatedAt: m.pairCreatedAt,
    observedAt: m.observedAt,
  };
}
