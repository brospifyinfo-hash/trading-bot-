import { isBase58Address, mint as toMint, type Clock, type Mint } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS, type KnownProviderId, type ProviderEnv } from "@sae/config";
import {
  DEFAULT_MARKET_SELECTION,
  selectMarket,
  type MarketCandidate,
  type MarketDataAdapter,
  type MarketFields,
} from "@sae/pipeline";
import { DexScreenerMarketAdapter, type DexScreenerMarket } from "@sae/providers";

import { quoteMarketAdapter } from "./quote-market-adapter";
import { buildQuoteMarketDeps } from "./quote-market-source";

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

/**
 * Zaehlt, warum ein Token keinen brauchbaren Markt hatte.
 *
 * Ohne sie endet jede Ablehnung als `noSource: 9` — eine Zahl, die sagt, DASS
 * neun Token nichts geliefert haben, und verschweigt, WARUM. `selectMarket`
 * kennt den Grund genau (`POOL_TOO_YOUNG`, `TURNOVER_IMPLAUSIBLE`,
 * `UNUSABLE_QUOTE`, …); er wurde bisher an drei Stellen hintereinander
 * weggeworfen, weil der Adapter nur `null` zurueckgeben kann.
 *
 * Die Ablage gehoert dem Aufrufer und wird nach jedem Lauf geleert. Absichtlich
 * kein zweiter Rueckgabewert an `MarketDataAdapter.fetchMarket`: dessen
 * Vertrag gilt fuer alle Anbieter, und eine Auswahlbegruendung ist eine
 * Eigenheit dieses einen.
 */
export interface RejectionTally {
  /** Ein Token ohne waehlbaren Markt, mit den Gruenden seiner Pools. */
  record(mint: string, reasons: readonly string[]): void;
  /**
   * Bei `UNUSABLE_QUOTE`: wogegen der Pool tatsaechlich handelte.
   *
   * Der Grund allein beantwortet die entscheidende Frage nicht. Zehn Pools
   * gegen **eine** Gegenwaehrung heisst: womoeglich fehlt uns ein legitimer
   * Anker, und ein Eintrag in `USD_ANCHOR_QUOTE_MINTS` verdreifacht die
   * nutzbaren Daten. Zehn Pools gegen **zehn verschiedene** Memecoins heisst:
   * der Filter hat recht und es gibt nichts zu tun. Beides sieht ohne diese
   * Auszaehlung gleich aus.
   */
  recordQuote(label: string): void;
  /**
   * Ausgang der Verkaufssonde — ein eigener Kanal, kein Anhaengsel.
   *
   * Eine misslungene Sonde ist kein fehlender Markt: der Preis steht, nur die
   * Ausstiegszahl fehlt. Sie in `record` zu zaehlen wuerde `tokens` erhoehen
   * und den Token als quellenlos ausweisen, obwohl eine Quelle geantwortet
   * hat — eine Zahl, die still etwas anderes bedeutet als ihr Name sagt.
   */
  recordExitProbe(outcome: string): void;
}

export interface RejectionCounts {
  /** Grund -> wie oft. Ein Token kann mehrere Pools mit je eigenem Grund haben. */
  readonly reasons: Readonly<Record<string, number>>;
  /** Gegenwaehrung -> wie oft, nur fuer `UNUSABLE_QUOTE`. */
  readonly quotes: Readonly<Record<string, number>>;
  /** Ausgang der Verkaufssonde -> wie oft. `OK` heisst: Ausstieg gemessen. */
  readonly exitProbes: Readonly<Record<string, number>>;
  /**
   * Wie viele ABRUFE ohne Markt endeten.
   *
   * Seit die Kette zwei Mitglieder hat, kann derselbe Token hier zweimal
   * zaehlen: einmal, weil der Router keinen Kurs lieferte, und einmal, weil
   * anschliessend auch die Marktdatenquelle nichts Brauchbares hatte. Das ist
   * kein Fehler, aber es heisst nicht mehr „so viele Token blieben leer" — und
   * weil dieser Unterschied genau die Sorte ist, die eine Zahl still falsch
   * macht, steht er hier ausgeschrieben.
   */
  readonly tokens: number;
}

/**
 * Macht aus einem Anbieter-Symbol etwas, das gefahrlos ins Log darf.
 *
 * Symbole waehlt der Token-Ersteller. Ein Zeilenumbruch darin zerlegt eine
 * Log-Zeile in zwei, und die zweite sieht aus wie ein eigener Eintrag —
 * das ist die billigste Art, eine Aufzeichnung unglaubwuerdig zu machen.
 */
function safeLabel(raw: string): string {
  const clean = raw.replace(/[^\p{L}\p{N}._-]/gu, "");
  if (clean === "") return "?";
  return clean.length > 16 ? clean.slice(0, 16) : clean;
}

export function createRejectionTally(): RejectionTally & { drain(): RejectionCounts } {
  let reasons: Record<string, number> = {};
  let quotes: Record<string, number> = {};
  let exitProbes: Record<string, number> = {};
  let tokens = 0;
  return {
    recordExitProbe(outcome: string): void {
      const key = safeLabel(outcome);
      const bisher = exitProbes[key];
      exitProbes[key] = bisher === undefined ? 1 : bisher + 1;
    },
    recordQuote(label: string): void {
      const key = safeLabel(label);
      const bisher = quotes[key];
      quotes[key] = bisher === undefined ? 1 : bisher + 1;
    },
    record(_mint: string, list: readonly string[]): void {
      tokens += 1;
      for (const r of list) {
        // Ausgeschrieben statt `(reasons[r] ?? 0) + 1`: `sae/no-numeric-fallback`
        // schlaegt dort an, und zwar zu Recht — die Regel kann einen Zaehler
        // nicht von einem ersetzten Messwert unterscheiden. Sie deshalb
        // stillzulegen waere der falsche Weg; zwei Zeilen sind billiger als
        // eine abgestumpfte Regel.
        const bisher = reasons[r];
        reasons[r] = bisher === undefined ? 1 : bisher + 1;
      }
    },
    drain(): RejectionCounts {
      const out = { reasons, quotes, exitProbes, tokens };
      reasons = {};
      quotes = {};
      exitProbes = {};
      tokens = 0;
      return out;
    },
  };
}

export interface MarketAdapterDeps {
  readonly env: ProviderEnv;
  readonly clock: Clock;
  /** Optional: sammelt die Ablehnungsgruende der Marktauswahl. */
  readonly rejections?: RejectionTally;
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

  const quote = quoteSourceAdapter(deps);
  if (quote !== null) map.set("jupiter-quote", quote);

  return map;
}

/**
 * Die Quelle, die einen Preis MIT Zeitstempel liefert.
 *
 * Sie steht in der Kette vor DexScreener (siehe `readProviderConfig`), und der
 * Unterschied ist nicht Geschwindigkeit, sondern Entscheidungsfaehigkeit: ein
 * Preis ohne bekanntes Alter kommt am Torwaechter `snapshotSupportsEntry`
 * nicht vorbei. Bis hierher galt das fuer JEDEN Preis im System (DECISIONS
 * §89, §94) — deshalb hat der Papierhandel nie eine Gelegenheit gesehen.
 *
 * ### Warum DexScreener trotzdem abgefragt wird
 *
 * Ein Quote nennt einen Preis und sonst nichts. Liquiditaet,
 * Marktkapitalisierung und Volumen kommen weiter von DexScreener und werden
 * als `companion` beigelegt. Das ist zulaessig, WEIL der Snapshot-Pfad die
 * Beitragenden mitfuehrt — und was dort fehlt, bleibt `null` statt 0.
 *
 * Der Begleitabruf laeuft ausdruecklich OHNE die Ablehnungszaehlung. Sonst
 * stuende jeder Token, den beide Quellen ablehnen, zweimal in der Statistik,
 * und die Zahlen im Log wuerden lautlos doppelt zaehlen.
 */
function quoteSourceAdapter(deps: MarketAdapterDeps): MarketDataAdapter | null {
  const begleiter = dexScreenerChainAdapter({ env: deps.env, clock: deps.clock });

  const quoteDeps = buildQuoteMarketDeps({
    env: deps.env,
    clock: deps.clock,
    // Dieselbe Grenze, die spaeter das harte Tor prueft. Sie hier zu
    // wiederholen statt sie zu beziehen waere die Sorte Doppelung, bei der
    // eine der beiden Zahlen irgendwann leise stehen bleibt.
    maxImpactBps: DEFAULT_STRATEGY_PARAMETERS.risk.maxPriceImpactBps,
    ...(deps.rejections === undefined
      ? {}
      : {
          onExitProbe: (_mint: string, outcome: string) =>
            deps.rejections?.recordExitProbe(outcome),
        }),
    companion: async (mint: string): Promise<Partial<MarketFields>> => {
      const result = await begleiter.fetchMarket(mint);
      // Kein Begleitdatensatz ist kein Fehler: der Preis steht auch ohne ihn,
      // und die fehlenden Felder bleiben fehlend.
      return result === null ? {} : result.value;
    },
    ...(deps.rejections === undefined
      ? {}
      : { onUnusable: (mint: string, reason: string) => deps.rejections?.record(mint, [reason]) }),
  });

  return quoteDeps === null ? null : quoteMarketAdapter(quoteDeps);
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
      if (chosen === null) {
        // Kein waehlbarer Markt. Der Grund steht in `selection.rejected` und
        // waere hier sonst zu Ende — `fetchMarket` kann nur `null` sagen.
        deps.rejections?.record(
          wanted,
          selection.rejected.length > 0
            ? selection.rejected.map((r) => r.rejection)
            : ["NO_POOL_REPORTED"],
        );
        // Wogegen gehandelt wurde, wenn die Gegenwaehrung der Ausschlussgrund
        // war. Das Symbol kommt aus der Anbieterantwort und ist frei
        // waehlbarer Text — deshalb `safeLabel`. Ohne Symbol die Adresse, die
        // ist eindeutig und nachschlagbar.
        for (const r of selection.rejected) {
          if (r.rejection !== "UNUSABLE_QUOTE") continue;
          const raw = byPool.get(r.poolAddress);
          deps.rejections?.recordQuote(raw?.quoteSymbol ?? raw?.quoteMint ?? "?");
        }
        return null;
      }

      // Ohne Preis kein Marktwert. `MarketFields.priceUsd` ist bewusst nicht
      // nullable — ein Datensatz ohne Preis ist kein Marktdatensatz.
      if (chosen.priceUsd === null) return null;

      const raw = byPool.get(chosen.poolAddress);
      return {
        value: {
          priceUsd: chosen.priceUsd,
          liquidityUsd: chosen.liquidityUsd,
          // Eine Marktdatenquelle rechnet keine Route und kann deshalb ueber
          // den Ausstieg nichts sagen. `null` heisst genau das.
          exitCapacityRatio: null,
          // In der geprueften Antwort fehlte `marketCap`. Fehlt es weiterhin,
          // bleibt es `null` — NOT_AVAILABLE, nicht 0.
          marketCapUsd: raw?.marketCapUsd ?? null,
          volume24hUsd: chosen.volume24hUsd,
          // Die Fenster stehen seit jeher in jeder Antwort — sie wurden hier
          // nur nie weitergereicht. `volume5mUsd` ist das Pflichtfeld des
          // Momentum-Teilscores (Gewicht 0.15); ohne es war der Score nicht
          // rechenbar, und niemand sah, dass die Daten dafuer schon da waren.
          volume5mUsd: raw?.volumeUsd.m5 ?? null,
          buys5m: raw?.txns.m5?.buys ?? null,
          sells5m: raw?.txns.m5?.sells ?? null,
          // DexScreener liefert keine Halterzahl.
          holders: null,
          // Und keinen Preiseinfluss: den kennt nur, wer eine Route rechnet.
          priceImpactBps: null,
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
