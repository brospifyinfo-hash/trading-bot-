import { providerId, type Clock, type ProviderId } from "@sae/core";
import type { MarketDataAdapter, MarketFields } from "@sae/pipeline";
import { quoteToMarket, type QuoteMarketResult, type QuoteSnapshot } from "@sae/pipeline";

/**
 * Der Anbieter, der einen Preis MIT Zeitstempel liefert.
 *
 * Er fuellt `observedAt` — das Feld, das `MarketDataAdapter` seit jeher
 * vorsieht und das bisher niemand fuellen konnte (DECISIONS §97). Damit
 * rechnet `sourced()` ein echtes `freshnessSeconds`, und der Torwaechter
 * `snapshotSupportsEntry` laesst zum ersten Mal eine Einstiegsentscheidung
 * zu.
 *
 * ### Warum die Abrufe eingespeist werden
 *
 * `fetchQuote` und `fetchSlotTime` sind Parameter und keine eingebauten
 * Aufrufe. Zwei Gruende, und beide zaehlen:
 *
 * 1. Der ganze Weg — Quote, Slot, Uhrzeit, Preis, Alter, Torwaechter — laesst
 *    sich damit ohne Netz pruefen. Genau hier wohnen die Fehler, die im
 *    Betrieb keiner sieht.
 * 2. Solange die Vertraege ungeprueft sind, liefern die echten Abrufe nichts.
 *    Der Adapter ist trotzdem vollstaendig und richtig — es fehlt nur der
 *    Beleg, nicht die Logik.
 *
 * ### Was er ausdruecklich NICHT tut
 *
 * Er ersetzt DexScreener nicht. Liquiditaet, Marktkapitalisierung und Volumen
 * kommen weiter von dort und werden hier nur durchgereicht; ein Quote sagt
 * darueber nichts. Was er beisteuert, ist der Preis und — das Entscheidende —
 * dessen Alter.
 */

/**
 * Dieselbe Kennung wie der Konfigurationseintrag — und ausdruecklich NICHT
 * `jupiter`.
 *
 * Der Router und die Marktquelle teilen sich einen Host und sonst nichts. Der
 * Ausfuehrungspfad kann ausfallen, waehrend sich Preise weiterhin einwandfrei
 * ablesen lassen, und umgekehrt. Eine gemeinsame Kennung wuerde beide Befunde
 * in eine Zeile werfen — im Dashboard, in der Provider-Health und in der
 * Herkunft jedes Snapshots.
 */
export const QUOTE_PROVIDER_ID: ProviderId = providerId("jupiter-quote");

/**
 * Was ein Kursabruf ergeben hat — mit Grund, wenn nichts.
 *
 * Frueher stand hier `| null`, und das hat eine Messung im Betrieb wertlos
 * gemacht: von 25 Token lieferten 20 keinen Kurs, und im Log stand dazu
 * genau ein Wort — `NO_QUOTE=20`. Ob der Router keinen Weg fand, ob er uns
 * drosselte oder ob er gar nicht antwortete, waren im Ergebnis dasselbe
 * `null`, obwohl es drei verschiedene Probleme mit drei verschiedenen
 * Gegenmassnahmen sind: Menge senken, Takt senken, Anbieter pruefen.
 *
 * Dieselbe Lehre wie bei `noSourceReasons` (DECISIONS §100), eine Ebene
 * tiefer.
 */
export type QuoteFetchResult =
  | { readonly kind: "OK"; readonly outAmountRaw: bigint; readonly contextSlot: number | null }
  | { readonly kind: "NONE"; readonly reason: string };

/** Was der Adapter fuer einen Token braucht, um ueberhaupt fragen zu koennen. */
export interface QuoteMarketDeps {
  readonly clock: Clock;
  /** Der Anker, gegen den gefragt wird. Gegen USDC ist das Ergebnis ein Dollarpreis. */
  readonly quoteMint: string;
  /**
   * Wie viel gefragt wird — in GANZEN Einheiten des Ankers, also z. B. 100
   * fuer 100 USDC.
   *
   * Zwei Festlegungen stecken darin, und beide haben einen Grund.
   *
   * **Die Seite.** Ein Quote haengt von der Menge ab: je groesser, desto mehr
   * Preiseinfluss. Fragte man von der TOKEN-Seite aus, muesste die Menge fuer
   * jeden Token anders sein — eine feste Rohmenge bedeutet bei 6
   * Dezimalstellen etwas voellig anderes als bei 9, und ohne den Preis (den
   * wir ja gerade erst suchen) laesst sie sich nicht sinnvoll waehlen.
   * Herausgekommen waere fuer den einen Token eine Staubmenge und fuer den
   * naechsten ein Auftrag, der den Pool leerraeumt; beide Preise waeren echt
   * gemessen und trotzdem nicht vergleichbar. Vom Anker aus gefragt ist es
   * fuer jeden Token dieselbe reale Summe. Nebenbei ist das die KAUFSEITE,
   * also genau die Richtung, die eine Einstiegsentscheidung angeht.
   *
   * **Die Einheit.** Ganze Anker-Einheiten und nicht die kleinste Einheit,
   * weil letztere von den Dezimalstellen des Ankers abhinge — und die werden
   * hier gelesen, nicht angenommen. Eine Rohmenge als Konstante waere still
   * falsch, sobald der Anker gewechselt wird.
   *
   * Die Menge gehoert damit zur Messung und nicht in eine Konstante tief im
   * Code — wer sie aendert, aendert den gemessenen Preis.
   */
  readonly probeNotional: number;
  /**
   * Dezimalstellen eines Mint. Ohne sie kein Preis.
   *
   * Wird fuer BEIDE Seiten benutzt, auch fuer den Anker. Dass USDC sechs
   * Stellen hat, ist bekannt — aber eine bekannte Zahl abzuschreiben ist genau
   * die Sorte Annahme, die dieses System nicht trifft, solange die Zahl
   * ablesbar ist. Der Aufrufer merkt sich das Ergebnis; Dezimalstellen eines
   * SPL-Mint sind nach der Erzeugung unveraenderlich.
   */
  readonly decimalsOf: (mint: string) => Promise<number | null>;
  readonly fetchQuote: (input: {
    readonly inputMint: string;
    readonly outputMint: string;
    readonly amountRaw: bigint;
  }) => Promise<QuoteFetchResult>;
  /** `null`, wenn die Uhrzeit des Slots nicht abrufbar ist. */
  readonly fetchSlotTime: (slot: number) => Promise<Date | null>;
  /** Ergaenzende Felder aus der Marktdatenquelle. Fehlend bleibt fehlend. */
  readonly companion?: (mint: string) => Promise<Partial<MarketFields>>;
  /** Fuer die Aufzeichnung, warum nichts herauskam. */
  readonly onUnusable?: (mint: string, reason: string) => void;
}

export function quoteMarketAdapter(deps: QuoteMarketDeps): MarketDataAdapter {
  return {
    providerId: QUOTE_PROVIDER_ID,
    capabilities: ["TOKEN_MARKET"],

    async fetchMarket(mint: string) {
      // Beide Seiten zusammen: der Aufrufer merkt sich Dezimalstellen, der
      // zweite Abruf kostet also nach dem ersten Token nichts mehr.
      const [decimals, quoteDecimals] = await Promise.all([
        deps.decimalsOf(mint),
        deps.decimalsOf(deps.quoteMint),
      ]);
      if (decimals === null) {
        // Ohne Dezimalstellen ist jede Preisrechnung um Zehnerpotenzen
        // daneben. Sie zu raten waere der teuerste denkbare Fehler.
        deps.onUnusable?.(mint, "NO_DECIMALS");
        return null;
      }
      if (quoteDecimals === null) {
        // Betrifft nicht diesen Token, sondern den Anker — also jeden Token.
        // Ein eigener Grund, damit im Log nicht zwoelfmal „NO_DECIMALS"
        // steht, wo einmal „der Anker ist nicht lesbar" gemeint ist.
        deps.onUnusable?.(mint, "NO_ANCHOR_DECIMALS");
        return null;
      }

      const probeAmountRaw = toRawAmount(deps.probeNotional, quoteDecimals);
      if (probeAmountRaw === null) {
        deps.onUnusable?.(mint, "BAD_PROBE_SIZE");
        return null;
      }

      // Gefragt wird mit dem Anker: „was bekomme ich fuer diese Summe?"
      const raw = await deps.fetchQuote({
        inputMint: deps.quoteMint,
        outputMint: mint,
        amountRaw: probeAmountRaw,
      });

      if (raw.kind !== "OK") {
        // Der Grund des Anbieters, unveraendert weitergereicht. Ein generisches
        // `NO_QUOTE` daraus zu machen waere derselbe Informationsverlust, den
        // diese Zeile gerade behebt.
        deps.onUnusable?.(mint, raw.reason);
        return null;
      }

      const quote: QuoteSnapshot = {
        // Gelesen wird die Messung von der TOKEN-Seite aus, und deshalb stehen
        // die Seiten hier andersherum als in der Anfrage. Das ist kein Dreher,
        // sondern der Zweck: `quoteUnitPrice` liefert „Preis einer
        // Eingabeeinheit in Ausgabeeinheiten". Eingabe = Token, Ausgabe = Anker
        // ergibt den Ankerpreis je Token, also den Dollarpreis. Andersherum
        // kaeme heraus, wie viele Token ein Dollar kauft — dieselbe Zahl auf
        // dem Kopf, und als Preis gefuehrt waere sie um Groessenordnungen
        // falsch.
        inAmountRaw: raw.outAmountRaw,
        inDecimals: decimals,
        outAmountRaw: probeAmountRaw,
        outDecimals: quoteDecimals,
        contextSlot: raw.contextSlot,
      };

      const slotTime =
        quote.contextSlot === null ? null : await deps.fetchSlotTime(quote.contextSlot);

      const companion: Partial<MarketFields> =
        deps.companion === undefined ? {} : await deps.companion(mint);
      const result: QuoteMarketResult = quoteToMarket({
        quote,
        slotTime,
        receivedAt: deps.clock.now(),
        liquidityUsd: companion.liquidityUsd ?? null,
        marketCapUsd: companion.marketCapUsd ?? null,
        volume24hUsd: companion.volume24hUsd ?? null,
        holders: companion.holders ?? null,
      });

      if (result.kind !== "MEASURED") {
        deps.onUnusable?.(mint, result.reason);
        return null;
      }

      // Der Kern: `observedAt` ist der Zeitpunkt des ANBIETERS, nicht unserer.
      return { value: result.value, observedAt: result.observedAt };
    },
  };
}

/**
 * Ganze Anker-Einheiten in die kleinste Einheit.
 *
 * Ganzzahlig gerechnet und nicht ueber `10 ** decimals` als Gleitkommazahl:
 * bei neun Stellen und einer dreistelligen Summe waere das noch exakt, bei
 * mehr nicht mehr — und ein um eine Einheit danebenliegender Nenner
 * verschiebt jeden Preis, ohne dass irgendetwas auffaellt.
 *
 * `null` bei allem, was keine sinnvolle Summe ist. Kein Ersatzwert: eine
 * stillschweigend auf 1 gesetzte Probemenge waere ein Staubauftrag, dessen
 * Preis nichts mit dem Markt zu tun haette.
 */
function toRawAmount(notional: number, decimals: number): bigint | null {
  if (!Number.isInteger(notional) || notional <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 32) return null;
  return BigInt(notional) * 10n ** BigInt(decimals);
}
