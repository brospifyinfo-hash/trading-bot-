import { zodContract, type ResponseContract } from "../contract";
import {
  dexScreenerResponseSchema,
  type DexScreenerPairRaw,
} from "./schema";

/**
 * Von der Antwortform des Anbieters in unser Vokabular.
 *
 * Die Trennung ist der Grund, warum ein Anbieterwechsel hier endet und nicht
 * in der Entscheidungsmaschine ankommt: alles Provider-Eigene (Zeichenketten
 * als Preise, verschachtelte Zeitfenster, Epoch-Millisekunden) wird hier
 * aufgeloest. Was herauskommt, kennt DexScreener nicht mehr.
 */

/** Ein Wert je Zeitfenster. `null` heisst: dieses Fenster kam nicht mit. */
export interface DexScreenerWindows<T> {
  readonly m5: T | null;
  readonly h1: T | null;
  readonly h6: T | null;
  readonly h24: T | null;
}

export interface DexScreenerTxns {
  readonly buys: number;
  readonly sells: number;
}

/**
 * Ein normalisierter Markt — ein **Handelspaar**, nicht ein Token.
 *
 * Der Unterschied traegt die halbe Architektur: ein Memecoin hat mehrere
 * Pools mit verschiedenen Preisen und verschiedener Ausstiegskapazitaet. Ohne
 * `pairAddress` und `dexId` ist keine Auswahl unter ihnen moeglich und keine
 * Auswahl aufzeichenbar.
 */
export interface DexScreenerMarket {
  readonly chainId: string;
  readonly dexId: string;
  readonly pairAddress: string;

  readonly baseMint: string;
  readonly baseSymbol: string | null;
  readonly quoteMint: string;
  readonly quoteSymbol: string | null;

  readonly priceUsd: number | null;
  readonly priceNative: number | null;

  readonly liquidityUsd: number | null;
  readonly liquidityBase: number | null;
  readonly liquidityQuote: number | null;

  /**
   * Beide in der geprueften Antwort NICHT enthalten.
   *
   * Sie bleiben `null` — und `null` heisst hier NOT_AVAILABLE, nicht 0. Aus
   * Preis und einer geschaetzten Umlaufmenge eine Marktkapitalisierung zu
   * rechnen waere genau die Erfindung, die dieses System ausschliesst.
   */
  readonly fdvUsd: number | null;
  readonly marketCapUsd: number | null;

  readonly volumeUsd: DexScreenerWindows<number>;
  readonly txns: DexScreenerWindows<DexScreenerTxns>;
  readonly priceChangePct: DexScreenerWindows<number>;

  readonly pairCreatedAt: Date | null;

  /**
   * Immer `null` — als Typ, nicht als Zufall.
   *
   * DexScreener liefert **keinen** Beobachtungszeitpunkt zur Preisangabe; das
   * ist an einer echten Antwort geprueft. Der Typ ist deshalb das Literal
   * `null` und nicht `Date | null`: so kann niemand hier spaeter den
   * Empfangszeitpunkt eintragen, ohne den Typ zu aendern und dabei zu merken,
   * was er tut. Ein erfundener Beobachtungszeitpunkt waere Look-Ahead mit
   * Wirkung bis in jeden Backtest.
   *
   * Folge, durchgesetzt von der Datenbank: `observed_at` bleibt NULL, und die
   * CHECK-Constraint `feature_obs_safety_needs_timestamp` laesst darauf nur
   * `RESEARCH_ONLY` zu.
   */
  readonly observedAt: null;
}

const win = <R, T>(
  // `| undefined` ausdruecklich in jedem Feld: unter
  // `exactOptionalPropertyTypes` ist `m5?: R` etwas anderes als
  // `m5?: R | undefined`, und Zods `passthrough()` liefert das Zweite.
  raw:
    | { m5?: R | undefined; h1?: R | undefined; h6?: R | undefined; h24?: R | undefined }
    | undefined,
  map: (value: R) => T,
): DexScreenerWindows<T> => {
  const one = (value: R | undefined): T | null => (value === undefined ? null : map(value));
  return {
    m5: one(raw?.m5),
    h1: one(raw?.h1),
    h6: one(raw?.h6),
    h24: one(raw?.h24),
  };
};

/**
 * Ein Paar aus der Antwort in unsere Form.
 *
 * `?? null` ueberall, wo der Anbieter das Feld weglassen kann: `undefined`
 * bedeutet „nicht geliefert" und wird zu `null` — nicht zu 0, nicht zu einem
 * Vorgabewert.
 */
export function normalizePair(raw: DexScreenerPairRaw): DexScreenerMarket {
  return {
    chainId: raw.chainId,
    dexId: raw.dexId,
    pairAddress: raw.pairAddress,

    baseMint: raw.baseToken.address,
    baseSymbol: raw.baseToken.symbol ?? null,
    quoteMint: raw.quoteToken.address,
    quoteSymbol: raw.quoteToken.symbol ?? null,

    priceUsd: raw.priceUsd ?? null,
    priceNative: raw.priceNative ?? null,

    liquidityUsd: raw.liquidity?.usd ?? null,
    liquidityBase: raw.liquidity?.base ?? null,
    liquidityQuote: raw.liquidity?.quote ?? null,

    fdvUsd: raw.fdv ?? null,
    marketCapUsd: raw.marketCap ?? null,

    // Typargumente ausdruecklich: `passthrough()` macht aus `m5?: number` den
    // Typ `number | undefined`, und die Inferenz zoege das `undefined` sonst
    // in den Fenstertyp — womit „Fenster fehlt" und „Wert unbekannt" wieder
    // dasselbe waeren.
    volumeUsd: win<number, number>(raw.volume, (v) => v),
    txns: win<{ buys: number; sells: number }, DexScreenerTxns>(raw.txns, (t) => ({
      buys: t.buys,
      sells: t.sells,
    })),
    priceChangePct: win<number, number>(raw.priceChange, (p) => p),

    pairCreatedAt: raw.pairCreatedAt === undefined ? null : new Date(raw.pairCreatedAt),

    observedAt: null,
  };
}

/**
 * Der geprüfte Vertrag.
 *
 * `verified: true`, weil das Schema aus einer **echten Antwort der API**
 * stammt — der unmittelbarsten Primaerquelle, die es gibt. Die Version traegt
 * das Datum der Stichprobe, damit spaeter nachvollziehbar bleibt, gegen
 * welchen Stand geprueft wurde; sie landet in
 * `feature_observations.schema_version`.
 *
 * Was `verified: true` NICHT behauptet: dass jede kuenftige Antwort passt. Sie
 * wird bei jedem Abruf erneut validiert, und eine abweichende Antwort erzeugt
 * `SCHEMA_REJECTED` statt eines halb geparsten Marktwerts.
 */
export const DEXSCREENER_MARKET_CONTRACT: ResponseContract<readonly DexScreenerMarket[]> =
  zodContract({
    schema: dexScreenerResponseSchema.transform((pairs) => pairs.map(normalizePair)),
    schemaVersion: "dexscreener-tokens-v1@2026-09-03",
    verified: true,
  });
