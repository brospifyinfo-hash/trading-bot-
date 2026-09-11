import type { MarketFields } from "./provider-chain";
import { quoteAge, quoteUnitPrice, type QuoteAge, type QuoteMeasurement } from "./quote-measurement";

/**
 * Aus einem Quote wird ein Marktdatensatz mit BEKANNTEM Alter.
 *
 * Die Naht, an der die letzte Luecke schliesst. Bemerkenswert daran ist, was
 * NICHT noetig war: der Vertrag `MarketDataAdapter.fetchMarket` gibt
 * `{ value, observedAt: Date | null }` zurueck, und `observedAt` ist
 * ausdruecklich „der Zeitstempel des ANBIETERS". Ein Quote kann diesen
 * Zeitstempel liefern — DexScreener kann es nicht. Es aendert sich also keine
 * Schnittstelle; es wird endlich eine ausgefuellt, die immer da war.
 *
 * Der Weg von hier: `sourced()` rechnet aus `providerObservedAt` das
 * `freshnessSeconds`, der Snapshot traegt es, und `snapshotSupportsEntry`
 * laesst zum ersten Mal eine Einstiegsentscheidung zu — ohne dass irgendwo
 * eine Zahl erfunden wurde.
 *
 * Diese Datei rechnet und entscheidet, sie ruft niemanden auf.
 */

export interface QuoteSnapshot extends QuoteMeasurement {
  /** Der Slot, zu dem der Anbieter gerechnet hat. `null` = er sagt es nicht. */
  readonly contextSlot: number | null;
}

export interface QuoteMarketInput {
  /** `null`, wenn der Router nichts geliefert hat. */
  readonly quote: QuoteSnapshot | null;
  /** Uhrzeit des `contextSlot`, von der Kette gelesen. */
  readonly slotTime: Date | null;
  readonly receivedAt: Date;
  /**
   * Ergaenzende Felder aus der Marktdatenquelle.
   *
   * Ein Quote nennt einen Preis, keine Liquiditaet und kein Volumen. Sie hier
   * aus einer anderen Quelle zu uebernehmen ist zulaessig, WEIL der
   * Snapshot-Pfad die Beitragenden mitfuehrt — was fehlt, bleibt `null` und
   * wird nirgends ersetzt.
   */
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly holders: number | null;
  /**
   * Preiseinfluss aus dem Quote — das eine Feld, das NUR ein Router liefern
   * kann.
   *
   * Es geht in die Ausfuehrungskosten ein, und die entscheiden mit darueber,
   * ob ein Vorteil nach Kosten noch einer ist. Eine Naeherung aus der
   * Pool-Tiefe waere hier besonders teuer: sie saehe plausibel aus und wuerde
   * genau dort danebenliegen, wo es weh tut — bei duennen Maerkten.
   */
  readonly priceImpactBps: number | null;
  /**
   * Ausstiegsfaehigkeit, gemessen mit einer zweiten Anfrage in der
   * VERKAUFSrichtung.
   *
   * Das Gegenstueck zu `priceImpactBps`: dieses misst, was der Einstieg
   * kostet, jenes, ob der Ausstieg ueberhaupt stattfindet. Ein Token kann
   * jeden Score der Welt haben und trotzdem eine Falle sein.
   */
  readonly exitCapacityRatio: number | null;
}

export type QuoteMarketResult =
  | {
      readonly kind: "MEASURED";
      readonly value: MarketFields;
      /** Der Zeitpunkt, zu dem der ANBIETER gerechnet hat. */
      readonly observedAt: Date;
      readonly ageSeconds: number;
    }
  /**
   * Nicht verwertbar — mit dem Grund, der es erklaert.
   *
   * Ausdruecklich kein `null`: „kein Quote" und „Quote ohne Zeitangabe" sind
   * verschiedene Befunde. Der erste heisst, dass der Token nicht handelbar
   * ist; der zweite, dass uns eine Zeitquelle fehlt. Sie zu vermengen hiesse,
   * ein Infrastrukturproblem wie eine Aussage ueber den Markt zu behandeln.
   */
  | { readonly kind: "UNUSABLE"; readonly reason: QuoteUnusableReason; readonly age: QuoteAge | null };

export type QuoteUnusableReason =
  | "NO_QUOTE"
  | "NO_PRICE"
  /** Der Router nennt keinen Slot — ohne ihn gibt es kein Alter. */
  | "NO_CONTEXT_SLOT"
  /** Der Slot ist bekannt, seine Uhrzeit nicht abrufbar. */
  | "NO_SLOT_TIME"
  /** Die Uhren widersprechen sich. */
  | "CLOCK_SKEW";

export function quoteToMarket(input: QuoteMarketInput): QuoteMarketResult {
  if (input.quote === null) return { kind: "UNUSABLE", reason: "NO_QUOTE", age: null };

  const priceUsd = quoteUnitPrice(input.quote);
  if (priceUsd === null) return { kind: "UNUSABLE", reason: "NO_PRICE", age: null };

  const age = quoteAge({
    contextSlot: input.quote.contextSlot,
    slotTime: input.slotTime,
    receivedAt: input.receivedAt,
  });

  if (age.kind !== "KNOWN") {
    // Ein Preis ohne Alter ist fuer die HISTORIE brauchbar und fuer eine
    // Einstiegsentscheidung nicht. Diese Stelle entscheidet nur ueber den
    // zweiten Fall — sie liefert dann nichts, statt ein Alter zu erfinden.
    return { kind: "UNUSABLE", reason: age.kind, age };
  }

  return {
    kind: "MEASURED",
    value: {
      priceUsd,
      liquidityUsd: input.liquidityUsd,
      marketCapUsd: input.marketCapUsd,
      volume24hUsd: input.volume24hUsd,
      volume5mUsd: input.volume5mUsd,
      buys5m: input.buys5m,
      sells5m: input.sells5m,
      holders: input.holders,
      priceImpactBps: input.priceImpactBps,
      exitCapacityRatio: input.exitCapacityRatio,
    },
    // Zurueckgerechnet aus dem gemessenen Alter: der Zeitpunkt, zu dem der
    // Anbieter gerechnet hat. Genau das erwartet `sourced()` als
    // `providerObservedAt`.
    observedAt: new Date(input.receivedAt.getTime() - age.seconds * 1_000),
    ageSeconds: age.seconds,
  };
}
