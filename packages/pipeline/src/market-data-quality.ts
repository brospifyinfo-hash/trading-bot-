import type { SourceTier } from "@sae/providers";

/**
 * Reicht diese Datenlage fuer eine Einstiegsentscheidung?
 *
 * Bisher pruefte das System zwei Dinge: Tier und Alter. Beides ist noetig und
 * beides sagt nichts darueber, ob die Felder, auf denen eine Entscheidung
 * beruht, ueberhaupt da sind. Ein Snapshot mit gueltigem Zeitstempel und
 * PRIMARY-Tier, in dem Liquiditaet und Volumen fehlen, passierte den alten Gate
 * — und erzeugte eine Gelegenheit, die auf zwei Loechern steht.
 *
 * Der Kern dieser Datei ist deshalb eine Unterscheidung, die das ganze System
 * traegt: **fehlend ist nicht null**. Ein Token ohne gemeldete Liquiditaet ist
 * nicht ein Token mit Liquiditaet 0 — das eine heisst „wir wissen es nicht",
 * das andere „es ist nichts da". Wer beides gleich behandelt, baut sich eine
 * Kennzahl, die aussieht wie eine Messung.
 *
 * Diese Datei kennt keinen Anbieter. Sie prueft eine Beobachtung, egal woher
 * sie kommt — damit ein Anbieterwechsel keine Aenderung an den
 * Qualitaetsregeln bedeutet. Sie importiert nichts aus dem uebrigen Pipeline-
 * Paket, damit sie die Basis bleiben kann, auf der `ingestion.ts` und `flow.ts`
 * aufsetzen, ohne einen Importzyklus zu erzeugen.
 */

/**
 * Die Felder, auf die sich eine Einstiegsentscheidung stuetzen kann.
 *
 * Alle sind `number | null`, weil kein Anbieter alle liefert — und weil ein
 * nicht geliefertes Feld als solches erkennbar bleiben muss. `null` steht hier
 * ausdruecklich fuer NOT_AVAILABLE, niemals fuer „0". Bewusst KEIN eigener
 * `Maybe`-Typ: `@sae/core` hat bereits einen, der etwas anderes bedeutet
 * (`Observation | Missing` mit Grund), und zwei gleichnamige Typen mit
 * verschiedener Bedeutung im selben Workspace sind eine Falle.
 *
 * Welche dieser Felder **noetig** sind, entscheidet nicht der Anbieter, sondern
 * `REQUIRED_FOR_ENTRY` weiter unten.
 */
export interface MarketDataFields {
  readonly priceUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly fdvUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly buyCount24h: number | null;
  readonly sellCount24h: number | null;
  readonly buyVolume24hUsd: number | null;
  readonly sellVolume24hUsd: number | null;
  readonly tradeCount24h: number | null;
  readonly uniqueWallets24h: number | null;
  readonly holders: number | null;
}

export type MarketDataField = keyof MarketDataFields;

/**
 * Nichts bekannt.
 *
 * Der Ausgangspunkt fuer jeden Adapter: er fuellt auf, was seine Quelle
 * tatsaechlich geliefert hat, und laesst den Rest auf `null`. So kann ein
 * Adapter kein Feld vergessen und dabei versehentlich eine 0 erben.
 */
export const NO_MARKET_DATA: MarketDataFields = {
  priceUsd: null,
  liquidityUsd: null,
  marketCapUsd: null,
  fdvUsd: null,
  volume24hUsd: null,
  buyCount24h: null,
  sellCount24h: null,
  buyVolume24hUsd: null,
  sellVolume24hUsd: null,
  tradeCount24h: null,
  uniqueWallets24h: null,
  holders: null,
};

/**
 * Ohne diese vier gibt es keine Einstiegsentscheidung.
 *
 * Die Auswahl ist bewusst klein und begruendet:
 *
 * - `priceUsd` — ohne Preis kein Einstieg, trivialerweise.
 * - `liquidityUsd` — bestimmt, ob die Position ueberhaupt wieder aufloesbar
 *   ist. Der teuerste Fehler bei Memecoins ist nicht ein falscher Einstieg,
 *   sondern ein Ausstieg, den der Markt nicht hergibt.
 * - `volume24hUsd` — trennt einen handelbaren Markt von einem toten.
 * - `marketCapUsd` — ohne Groessenordnung ist kein Risiko bemessbar.
 *
 * Alles Weitere (Buy/Sell-Zaehler, Unique Wallets, FDV) verbessert eine
 * Entscheidung, traegt sie aber nicht allein. Es fehlt bei vielen Anbietern und
 * darf deshalb nicht zur Pflicht werden — sonst waere die Anbieterwahl eine
 * Strategieentscheidung.
 */
export const REQUIRED_FOR_ENTRY: readonly MarketDataField[] = [
  "priceUsd",
  "liquidityUsd",
  "volume24hUsd",
  "marketCapUsd",
];

export interface QualityThresholds {
  /** Aelter als das: keine Entscheidung. */
  readonly maxAgeSeconds: number;
  /**
   * Untergrenzen. Ein Wert DARUNTER ist eine gemessene Aussage und kein
   * Fehler — der Token ist dann zu klein, nicht unbekannt. Beides fuehrt zu
   * keiner Gelegenheit, aber aus verschiedenen Gruenden, und die Begruendung
   * gehoert in die Aufzeichnung.
   */
  readonly minLiquidityUsd: number;
  readonly minVolume24hUsd: number;
}

/**
 * Bewusst konservativ und ausdruecklich **nicht** kalibriert.
 *
 * Diese Zahlen sind Plausibilitaetsgrenzen, keine Strategieparameter. Sie aus
 * Backtests abzuleiten waere Optimierung auf Vergangenheit; sie hier zu
 * verstecken waere schlimmer. Wer sie aendert, aendert eine Sicherheitsgrenze
 * und keine Strategie.
 *
 * `maxAgeSeconds` ist absichtlich derselbe Wert wie in
 * `DEFAULT_INGEST_SETTINGS` — dieselbe Frage darf nicht zwei Antworten haben.
 */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  maxAgeSeconds: 120,
  minLiquidityUsd: 5_000,
  minVolume24hUsd: 1_000,
};

export type QualityVerdict =
  | { readonly kind: "PASS" }
  /** Ein Pflichtfeld fehlt — wir wissen es nicht. */
  | { readonly kind: "INCOMPLETE"; readonly missing: readonly MarketDataField[] }
  /** Alles da, aber der Markt traegt keine Position. */
  | { readonly kind: "BELOW_THRESHOLD"; readonly field: MarketDataField; readonly reason: string }
  | { readonly kind: "STALE"; readonly ageSeconds: number }
  | { readonly kind: "UNTRUSTED_SOURCE"; readonly tier: SourceTier }
  /** Ein Wert, den es so nicht geben kann. */
  | { readonly kind: "IMPLAUSIBLE"; readonly field: MarketDataField; readonly reason: string };

export interface QualityInput {
  readonly fields: MarketDataFields;
  readonly tier: SourceTier;
  readonly freshnessSeconds: number;
  readonly thresholds?: QualityThresholds;
}

/**
 * Die Reihenfolge der Pruefungen ist Absicht.
 *
 * Zuerst das, was ohne Feldwerte entscheidbar ist (Quelle, Alter), dann die
 * Vollstaendigkeit, dann Plausibilitaet, zuletzt die Schwellen. So nennt eine
 * Ablehnung den eigentlichen Grund und nicht den Folgefehler: „Daten sind 900 s
 * alt" ist eine bessere Auskunft als „Liquiditaet zu niedrig", wenn beides
 * zutrifft und das Alter die Ursache ist.
 */
export function assessMarketData(input: QualityInput): QualityVerdict {
  const t = input.thresholds ?? DEFAULT_QUALITY_THRESHOLDS;

  if (input.tier === "FALLBACK") {
    return { kind: "UNTRUSTED_SOURCE", tier: input.tier };
  }

  if (input.freshnessSeconds > t.maxAgeSeconds) {
    return { kind: "STALE", ageSeconds: input.freshnessSeconds };
  }

  const missing = REQUIRED_FOR_ENTRY.filter((f) => input.fields[f] === null);
  if (missing.length > 0) {
    return { kind: "INCOMPLETE", missing };
  }

  // Ab hier sind die Pflichtfelder nachweislich vorhanden. Die
  // Nicht-Null-Zusicherungen sind durch die Pruefung darueber gedeckt.
  const price = input.fields.priceUsd as number;
  const liquidity = input.fields.liquidityUsd as number;
  const volume = input.fields.volume24hUsd as number;
  const marketCap = input.fields.marketCapUsd as number;

  // Plausibilitaet vor Schwellen: ein negativer Preis ist kein zu kleiner
  // Markt, sondern ein kaputter Datensatz. Die beiden zu vermischen hiesse,
  // einen Anbieterfehler als Marktaussage zu verbuchen.
  for (const [field, value] of [
    ["priceUsd", price],
    ["liquidityUsd", liquidity],
    ["volume24hUsd", volume],
    ["marketCapUsd", marketCap],
  ] as const) {
    if (!Number.isFinite(value)) {
      return { kind: "IMPLAUSIBLE", field, reason: "kein endlicher Zahlenwert" };
    }
    if (value < 0) {
      return { kind: "IMPLAUSIBLE", field, reason: "negativ" };
    }
  }
  if (price === 0) {
    return { kind: "IMPLAUSIBLE", field: "priceUsd", reason: "Preis 0 ist kein handelbarer Preis" };
  }

  if (liquidity < t.minLiquidityUsd) {
    return {
      kind: "BELOW_THRESHOLD",
      field: "liquidityUsd",
      reason: `${liquidity.toFixed(0)} USD, verlangt sind ${String(t.minLiquidityUsd)} USD`,
    };
  }
  if (volume < t.minVolume24hUsd) {
    return {
      kind: "BELOW_THRESHOLD",
      field: "volume24hUsd",
      reason: `${volume.toFixed(0)} USD, verlangt sind ${String(t.minVolume24hUsd)} USD`,
    };
  }

  return { kind: "PASS" };
}

/**
 * Fuer die Aufzeichnung: warum kam keine Gelegenheit zustande?
 *
 * Ein Satz, der ohne Kenntnis des Codes lesbar ist. Er landet in der
 * Ablehnungsspur und beantwortet spaeter die Frage, ob eine Ablehnung richtig
 * war — die man ohne Begruendung nie beantworten kann.
 */
export function explainVerdict(verdict: QualityVerdict): string {
  switch (verdict.kind) {
    case "PASS":
      return "Datenlage traegt eine Einstiegsentscheidung.";
    case "INCOMPLETE":
      return `Pflichtfelder fehlen: ${verdict.missing.join(", ")}. Fehlend ist nicht null — ohne diese Werte gibt es keine Entscheidung.`;
    case "BELOW_THRESHOLD":
      return `${verdict.field} unter der Grenze: ${verdict.reason}. Gemessen, nicht unbekannt.`;
    case "STALE":
      return `Daten ${verdict.ageSeconds.toFixed(0)} s alt.`;
    case "UNTRUSTED_SOURCE":
      return `Quelle im Tier ${verdict.tier} traegt keine Einstiegsentscheidung.`;
    case "IMPLAUSIBLE":
      return `${verdict.field} ist ${verdict.reason} — das ist ein Anbieterfehler, keine Marktaussage.`;
  }
}

/** Kurzform fuer den Gate: nur bei PASS entsteht eine Gelegenheit. */
export function marketDataSupportsEntry(input: QualityInput): boolean {
  return assessMarketData(input).kind === "PASS";
}

/**
 * Welche der zwoelf Felder diese Quelle tatsaechlich geliefert hat.
 *
 * Fuer die Anbieterbeobachtung: ein Anbieter, der ein Feld laut Dokumentation
 * fuehrt und es im Betrieb nie liefert, faellt nur auf, wenn jemand mitzaehlt.
 * Bewusst KEIN Score — ein Anteil vorhandener Felder waere eine Zahl, die man
 * mit Datenqualitaet verwechselt.
 */
export function availableFields(fields: MarketDataFields): readonly MarketDataField[] {
  return (Object.keys(fields) as MarketDataField[]).filter((f) => fields[f] !== null);
}

/**
 * Baut den vollstaendigen Feldsatz aus dem, was eine Quelle geliefert hat.
 *
 * Der Ausgangspunkt ist `NO_MARKET_DATA`, nicht ein leeres Objekt: was der
 * Aufrufer nicht setzt, bleibt `null` — also NOT_AVAILABLE. Genau darum gibt es
 * diese Funktion. Ein Adapter, der von Hand ein Objekt baut, vergisst irgendwann
 * ein Feld; ohne diesen Ausgangspunkt waere das ein `undefined`, das weiter oben
 * zu einer 0 wird, und aus „unbekannt" waere „nichts vorhanden" geworden.
 *
 * Nimmt bewusst eine strukturelle Teilmenge: `MarketFields` der Anbieterkette
 * und `MarketObservation` der Aufnahme passen beide hier hinein, ohne dass
 * diese Datei eines der beiden Module kennen muss.
 */
export function marketDataFieldsFrom(partial: Partial<MarketDataFields>): MarketDataFields {
  return { ...NO_MARKET_DATA, ...partial };
}
