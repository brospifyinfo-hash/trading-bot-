import type { Clock } from "@sae/core";
import type { ProviderEnv } from "@sae/config";
import type { MarketFields } from "@sae/pipeline";
import {
  decimalFractionToBps,
  JupiterQuoteAdapter,
  AdaptivePacer,
  SolanaBlockTimeAdapter,
  SolanaMintAdapter,
} from "@sae/providers";

import type { QuoteFetchResult, QuoteMarketDeps } from "./quote-market-adapter";

/**
 * Die Abrufe hinter dem Quote-Marktadapter.
 *
 * `quoteMarketAdapter` bekommt seine drei Abrufe eingespeist und weiss
 * deshalb nichts von HTTP. Hier werden sie an die echten Anbieter gebunden —
 * getrennt gehalten, damit die Rechnung dort ohne Netz pruefbar bleibt und
 * die Verkabelung hier fuer sich betrachtet werden kann.
 *
 * ### Drei Anbieter fuer einen Preis
 *
 * 1. **Jupiter** beantwortet „was bekomme ich fuer 100 USDC?" und nennt dabei
 *    den `contextSlot`, zu dem gerechnet wurde.
 * 2. **`getBlockTime`** macht aus diesem Slot eine Uhrzeit. Abgelesen, nicht
 *    aus dem 400-ms-Zieltakt geschaetzt.
 * 3. **`getAccountInfo`** liefert die Dezimalstellen beider Seiten. Ohne sie
 *    ist jede Preisrechnung um Zehnerpotenzen daneben.
 *
 * ### Warum gemerkt wird
 *
 * Zwei der drei Antworten aendern sich nie: die Dezimalstellen eines
 * SPL-Mint stehen nach der Erzeugung fest, und die Uhrzeit eines bestaetigten
 * Slots ebenfalls. Sie bei jedem Takt erneut abzufragen waere derselbe
 * Leerlauf, der im September das Datenkontingent aufgebraucht hat
 * (DECISIONS §101) — nur diesmal beim RPC-Anbieter.
 *
 * Gemerkt werden ausschliesslich ERFOLGE. Ein `null` aus einem einmaligen
 * Ausfall zu merken hiesse, einen Token dauerhaft aus dem System zu nehmen,
 * weil das RPC einmal nicht erreichbar war.
 */

/**
 * Der Anker: USDC.
 *
 * Gegen ihn gerechnet ist das Ergebnis ein Dollarpreis. Gegen SOL waere es ein
 * SOL-Preis, und ihn als Dollarpreis zu fuehren waere derselbe Fehler, den
 * `UNUSABLE_QUOTE` in der Marktauswahl verhindert. Die Dezimalstellen werden
 * trotzdem gelesen und nicht hier hingeschrieben — siehe `decimalsOf`.
 */
export const QUOTE_ANCHOR_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Die Probesumme: 100 USDC.
 *
 * Ein SIMULATIONSPARAMETER, kein Marktwert — dieselbe Sorte Zahl wie das
 * Papier-Portfolio. Sie bestimmt, wie viel Preiseinfluss in den gemessenen
 * Preis eingeht, und ist bewusst in der Groessenordnung gewaehlt, in der
 * dieses System tatsaechlich handeln wuerde. Eine Staubmenge ergaebe einen
 * Preis, den niemand bekommt; eine sehr grosse ergaebe einen, der den Pool
 * leerraeumt.
 */
export const QUOTE_PROBE_NOTIONAL = 100;

/**
 * Das Vielfache der Position, mit dem der Ausstieg geprueft wird.
 *
 * Fuenf, weil dort die Bewertung ihre Obergrenze hat: `liquidityScore` legt
 * die Ausstiegsfaehigkeit auf eine Rampe von 1 bis 5. Bei drei zu fragen
 * (der Grenze des harten Tors) wuerde jeden Token auf halbem Rampenweg
 * deckeln, obwohl er mehr hergibt — die Messung waere dann strenger als das
 * Tor, das sie bedient.
 *
 * Der Preis dafuer ist eine zweite Router-Anfrage je Token. Das ist der
 * teuerste Posten dieser Aenderung und bewusst in Kauf genommen: ohne diese
 * Zahl lehnt das harte Tor JEDEN Token ab (DECISIONS §119).
 */
export const EXIT_PROBE_MULTIPLE = 5;

/**
 * Slippage-Vorgabe der Anfrage.
 *
 * Beeinflusst `outAmount` NICHT — sie geht nur in `otherAmountThreshold`, also
 * in die Grenze, unterhalb derer eine echte Ausfuehrung abbraeche. Fuer die
 * Messung ist der Wert damit ohne Belang; er muss nur mitgeschickt werden.
 */
const PROBE_SLIPPAGE_BPS = 50;

/** Wie viele gemerkte Antworten hoechstens gehalten werden. */
const MEMO_LIMIT = 5_000;

/**
 * Wie schnell gegen den Router gefragt werden darf.
 *
 * Gemessen am 2026-09-11 im Betrieb: von 25 Token in einem Lauf endeten **21**
 * mit `QUOTE_RATE_LIMITED`. Vier kamen durch. Die Anfragen gingen so schnell
 * hintereinander hinaus, wie die Schleife sie stellte — also praktisch als
 * Stoss.
 *
 * Eine Anfrage je Sekunde, mit einem kleinen Puffer fuer den Start. Die genaue
 * Grenze des Anbieters steht nirgends; diese Werte sind bewusst vorsichtig
 * gewaehlt und werden an derselben Log-Zeile nachgeprueft, an der das Problem
 * sichtbar wurde. Steht dort weiterhin `QUOTE_RATE_LIMITED`, ist es noch zu
 * schnell.
 *
 * Der Tausch dahinter: lieber ZEHN Token je Lauf mit Ergebnis als
 * fuenfundzwanzig, von denen einundzwanzig leer ausgehen. Die Zahl der
 * Anfragen sinkt, die Zahl der brauchbaren Antworten steigt.
 */
/**
 * Startwert, Boden und Decke des Abstands zwischen zwei Quote-Anfragen.
 *
 * Feste Werte waren der erste Versuch und haben nicht gereicht: eine Anfrage
 * je Sekunde liess immer noch 5 von 10 in die Drosselung laufen. Die Grenze
 * des Anbieters steht nirgends, also wird sie nicht geraten, sondern gesucht
 * (siehe `AdaptivePacer`).
 *
 * Die Decke ist die wichtigere der beiden Grenzen: bei fuenf Token je Lauf und
 * vier Sekunden Abstand dauert ein Lauf hoechstens 20 Sekunden — genau ein
 * Takt. Ohne sie koennte eine anhaltende Stoerung den Auftrag ueber sein
 * Zeitfenster ziehen, und dann liegt nicht der Anbieter brach, sondern die
 * Queue.
 */
const QUOTE_START_INTERVAL_MS = 2_000;
const QUOTE_MIN_INTERVAL_MS = 1_000;
const QUOTE_MAX_INTERVAL_MS = 4_000;

export interface QuoteSourceInput {
  readonly env: ProviderEnv;
  readonly clock: Clock;
  /** Ergaenzende Felder (Liquiditaet, Volumen, Marktkapitalisierung). */
  readonly companion?: (mint: string) => Promise<Partial<MarketFields>>;
  readonly onUnusable?: (mint: string, reason: string) => void;
  readonly onExitProbe?: (mint: string, outcome: string) => void;
  /**
   * Die Impact-Obergrenze, gegen die der Ausstieg gemessen wird.
   *
   * Kommt aus den Strategieparametern (`risk.maxPriceImpactBps`) und steht
   * deshalb nicht als Konstante hier: wer die Grenze verschiebt, verschiebt
   * damit auch die Bedeutung der gemessenen Ausstiegszahl, und beides muss
   * dieselbe Quelle haben.
   */
  readonly maxImpactBps: number;
  /**
   * Nur fuer Tests.
   *
   * Die Verkabelung ist die Stelle, an der ein vertauschter Anbieter oder ein
   * vergessenes Merken unbemerkt bliebe — beides sieht im Betrieb aus wie ein
   * langsamer Anbieter. Ohne diese Naht liesse sich genau das nicht pruefen.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Nur fuer Tests: das Warten zwischen zwei Anfragen.
   *
   * Ohne diese Naht muesste ein Test echte Sekunden verstreichen lassen, um
   * die Drosselung zu pruefen — und ein Test, der Sekunden braucht, wird
   * irgendwann uebersprungen.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Baut die Abhaengigkeiten — oder `null`, wenn die Quelle nicht arbeiten kann.
 *
 * `null` und kein halbfertiger Adapter: ohne eine der beiden Adressen kaeme
 * bei jedem Token dieselbe Ablehnung heraus, und eine Kette voller Mitglieder,
 * die zuverlaessig nichts liefern, verschleiert genau das.
 */
export function buildQuoteMarketDeps(input: QuoteSourceInput): QuoteMarketDeps | null {
  const baseUrl = input.env.JUPITER_BASE_URL;
  const rpcUrl = input.env.SOLANA_RPC_URL;
  if (baseUrl === undefined || rpcUrl === undefined) return null;

  const seam = input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl };
  const quotes = new JupiterQuoteAdapter({ clock: input.clock, baseUrl, ...seam });
  const blockTime = new SolanaBlockTimeAdapter({ clock: input.clock, rpcUrl, ...seam });
  const mints = new SolanaMintAdapter({ clock: input.clock, rpcUrl, ...seam });

  const decimalsMemo = new Map<string, number>();
  const slotTimeMemo = new Map<number, Date>();

  const pacer = new AdaptivePacer({
    clock: input.clock,
    startIntervalMs: QUOTE_START_INTERVAL_MS,
    minIntervalMs: QUOTE_MIN_INTERVAL_MS,
    maxIntervalMs: QUOTE_MAX_INTERVAL_MS,
  });
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    clock: input.clock,
    quoteMint: QUOTE_ANCHOR_MINT,
    probeNotional: QUOTE_PROBE_NOTIONAL,

    async decimalsOf(mint: string): Promise<number | null> {
      const gemerkt = decimalsMemo.get(mint);
      if (gemerkt !== undefined) return gemerkt;

      const outcome = await mints.fetchMint(mint);
      // `OK` mit `account: null` heisst: die Adresse ist kein Mint. Das ist
      // eine Auskunft und wird trotzdem nicht gemerkt — sie sagt nichts
      // darueber, ob der naechste Versuch dasselbe ergibt.
      if (outcome.kind !== "OK" || outcome.account === null) return null;

      remember(decimalsMemo, mint, outcome.account.decimals);
      return outcome.account.decimals;
    },

    async fetchQuote(request): Promise<QuoteFetchResult> {
      // Warten, bevor gefragt wird — nicht erst, wenn der Anbieter „nein"
      // sagt. Eine abgewiesene Anfrage kostet dasselbe wie eine erlaubte und
      // liefert nichts.
      const warten = pacer.waitMs();
      if (warten > 0) await sleep(warten);

      const outcome = await quotes.fetchQuote({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amountRaw: request.amountRaw,
        slippageBps: PROBE_SLIPPAGE_BPS,
      });

      // Der Takt lernt aus jeder Antwort. Eine Drosselung heisst sofort
      // deutlich langsamer; Erfolge heben das Tempo erst nach einer Reihe.
      if (outcome.kind === "FAILED" && outcome.failure === "RATE_LIMITED") {
        pacer.onRateLimited();
      } else if (outcome.kind === "OK") {
        pacer.onSuccess();
      }

      if (outcome.kind === "FAILED") {
        // Der Grund des Anbieters, benannt statt eingeebnet.
        //
        // `QUOTE_RATE_LIMITED` heisst: Takt oder Tokenzahl senken.
        // `QUOTE_BAD_REQUEST` heisst am ehesten: fuer dieses Paar in dieser
        // Groesse gibt es keinen Weg — also Probesumme senken oder den Token
        // abschreiben. `QUOTE_BLOCKED` heisst: jemand laesst uns nicht durch.
        // Drei Probleme, drei Gegenmassnahmen, und vorher sahen alle drei
        // gleich aus.
        return { kind: "NONE", reason: `QUOTE_${outcome.failure}` };
      }
      if (outcome.kind === "SCHEMA_REJECTED") {
        return { kind: "NONE", reason: "QUOTE_SCHEMA_REJECTED" };
      }

      // `outAmount` kommt als Text, weil ein u64 nicht verlustfrei in eine
      // JSON-Zahl passt. Genau so wird er auch weitergereicht: als BigInt,
      // nie als `number`.
      const outAmountRaw = toBigInt(outcome.quote.outAmount);
      if (outAmountRaw === null) return { kind: "NONE", reason: "QUOTE_BAD_AMOUNT" };

      return {
        kind: "OK",
        outAmountRaw,
        // `priceImpactPct` ist ein Anteil als Text ("0.0123"). Die Umrechnung
        // liegt beim Anbietermodul, damit sie an einer Stelle steht.
        priceImpactBps: impactBps(outcome.quote.priceImpactPct),
        // Fehlt der Slot, faellt der Token flussabwaerts mit
        // `NO_CONTEXT_SLOT` heraus. Kein Ersatz aus unserer Uhr.
        contextSlot: outcome.quote.contextSlot ?? null,
      };
    },

    async fetchSlotTime(slot: number): Promise<Date | null> {
      const gemerkt = slotTimeMemo.get(slot);
      if (gemerkt !== undefined) return gemerkt;

      const outcome = await blockTime.fetchBlockTime(slot);
      // `at: null` heisst: den Slot gibt es beim Knoten nicht (mehr). Auch das
      // wird nicht gemerkt — ein anderer Knoten koennte ihn haben.
      if (outcome.kind !== "OK" || outcome.at === null) return null;

      remember(slotTimeMemo, slot, outcome.at);
      return outcome.at;
    },

    exitProbe: { multiple: EXIT_PROBE_MULTIPLE, maxImpactBps: input.maxImpactBps },

    ...(input.companion === undefined ? {} : { companion: input.companion }),
    ...(input.onUnusable === undefined ? {} : { onUnusable: input.onUnusable }),
    ...(input.onExitProbe === undefined ? {} : { onExitProbe: input.onExitProbe }),
  };
}

/**
 * Merken mit Deckel.
 *
 * Beim Erreichen der Grenze wird geleert statt verdraengt. Eine echte
 * LRU-Verdraengung waere hier mehr Mechanik, als der Zweck traegt: die
 * Eintraege sind unveraenderlich, ein Verlust kostet einen erneuten Abruf und
 * sonst nichts.
 */
function remember<K, V>(memo: Map<K, V>, key: K, value: V): void {
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, value);
}

/** `null` statt einer Ausnahme oder einer stillen 0. */
function toBigInt(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * Preiseinfluss als Basispunkte — oder `null`, wenn er nicht lesbar ist.
 *
 * `decimalFractionToBps` wirft bei Unsinn, und das waere hier falsch: ein
 * unlesbarer Preiseinfluss macht den Kurs nicht wertlos, er kostet nur ein
 * Feature. Geworfen wuerde er den ganzen Abruf mitreissen.
 */
function impactBps(raw: string): number | null {
  try {
    return decimalFractionToBps(raw);
  } catch {
    return null;
  }
}
