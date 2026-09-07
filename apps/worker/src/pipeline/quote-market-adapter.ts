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

export const QUOTE_PROVIDER_ID: ProviderId = providerId("jupiter");

/** Was der Adapter fuer einen Token braucht, um ueberhaupt fragen zu koennen. */
export interface QuoteMarketDeps {
  readonly clock: Clock;
  /** Der Anker, gegen den gefragt wird. Gegen USDC ist das Ergebnis ein Dollarpreis. */
  readonly quoteMint: string;
  readonly quoteDecimals: number;
  /**
   * Wie viel gefragt wird, in kleinster Einheit des GESUCHTEN Token.
   *
   * Ein Quote haengt von der Menge ab: je groesser, desto mehr Preiseinfluss.
   * Die Menge gehoert deshalb zur Messung und nicht in eine Konstante tief im
   * Code — wer sie aendert, aendert den gemessenen Preis.
   */
  readonly probeAmountRaw: bigint;
  /** Dezimalstellen des gesuchten Token. Ohne sie kein Preis. */
  readonly decimalsOf: (mint: string) => Promise<number | null>;
  readonly fetchQuote: (input: {
    readonly inputMint: string;
    readonly outputMint: string;
    readonly amountRaw: bigint;
  }) => Promise<{ readonly outAmountRaw: bigint; readonly contextSlot: number | null } | null>;
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
      const decimals = await deps.decimalsOf(mint);
      if (decimals === null) {
        // Ohne Dezimalstellen ist jede Preisrechnung um Zehnerpotenzen
        // daneben. Sie zu raten waere der teuerste denkbare Fehler.
        deps.onUnusable?.(mint, "NO_DECIMALS");
        return null;
      }

      const raw = await deps.fetchQuote({
        inputMint: mint,
        outputMint: deps.quoteMint,
        amountRaw: deps.probeAmountRaw,
      });

      const quote: QuoteSnapshot | null =
        raw === null
          ? null
          : {
              inAmountRaw: deps.probeAmountRaw,
              inDecimals: decimals,
              outAmountRaw: raw.outAmountRaw,
              outDecimals: deps.quoteDecimals,
              contextSlot: raw.contextSlot,
            };

      const slotTime =
        quote?.contextSlot === undefined || quote.contextSlot === null
          ? null
          : await deps.fetchSlotTime(quote.contextSlot);

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
