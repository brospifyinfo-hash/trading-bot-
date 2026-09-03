import type { Mint, PoolAddress } from "@sae/core";

/**
 * Welcher Markt eines Tokens traegt die Analyse — und warum dieser?
 *
 * Ein Solana-Memecoin hat selten genau einen Pool. Er hat einen auf Raydium,
 * einen auf Orca, dazu oft einen Rest aus der Launch-Phase mit vierstelliger
 * Liquiditaet. Diese Pools haben **verschiedene Preise, verschiedene
 * Liquiditaet und verschiedene Ausstiegskapazitaet**. Wer den ersten nimmt, den
 * die Antwort liefert, hat seine wichtigste Kennzahl von der Sortierreihenfolge
 * eines Anbieters abhaengig gemacht.
 *
 * Bis hierher kannte die Pipeline diese Frage nicht. Ein Markt war ein Token:
 * `fetchMarket(mint)` ging rein, ein Preis kam raus, und was dazwischen mit
 * mehreren Pools geschah, stand nirgends. `token_pools` existiert als Tabelle
 * und wird von keiner Zeile Code beschrieben; `DiscoveredToken.poolAddress`
 * wird gesetzt und danach fallengelassen.
 *
 * Diese Datei schliesst die Luecke, und sie tut es anbieterunabhaengig: sie
 * arbeitet auf `MarketCandidate`, unserem Vokabular, nicht auf der Antwortform
 * irgendeines Anbieters. Ein Adapter uebersetzt in dieses Vokabular; die Regeln
 * hier bleiben davon unberuehrt.
 *
 * Zwei Festlegungen tragen alles Weitere:
 *
 * 1. **Erst ausschliessen, dann ordnen.** Ein Pool, der eine harte Bedingung
 *    verletzt, wird nicht schlechter bewertet — er faellt raus, mit Grund.
 *    Ein Ausschluss, der sich durch eine gute Zahl an anderer Stelle
 *    aufwiegen laesst, ist kein Ausschluss.
 * 2. **Die Auswahl ist deterministisch und aufzeichenbar.** Gleiche Eingabe,
 *    gleiche Ausgabe — unabhaengig von der Reihenfolge, in der die Kandidaten
 *    ankamen. Ohne das ist die spaetere Frage „warum dieser Markt" nicht
 *    beantwortbar, und ein Backtest reproduziert die Auswahl nicht.
 */

/**
 * Ein Markt, wie ihn unser System kennt.
 *
 * Alle Kennzahlen sind `| null`, weil kein Anbieter alles liefert — und weil
 * fehlend nicht null bedeutet. Ein Pool ohne gemeldete Liquiditaet ist nicht
 * ein Pool mit Liquiditaet 0; das eine ist unbekannt, das andere ist leer.
 * Die Unterscheidung entscheidet hier ueber zwei verschiedene Ausschlussgruende.
 */
export interface MarketCandidate {
  /** Die Identitaet des Marktes. Ohne sie ist keine Auswahl aufzeichenbar. */
  readonly poolAddress: PoolAddress;
  /** Etikett des Anbieters, kleingeschrieben normalisiert (z. B. "raydium"). */
  readonly dex: string;
  /** Der Token, um den es geht. */
  readonly baseMint: Mint;
  /** Wogegen er handelt. Entscheidet, ob der Preis ueberhaupt verankert ist. */
  readonly quoteMint: Mint;
  readonly priceUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly buyCount24h: number | null;
  readonly sellCount24h: number | null;
  /** Wann der Pool entstand. Fuer das Alter — junge Pools sind eine eigene Klasse. */
  readonly pairCreatedAt: Date | null;
  /** Zeitpunkt der Beobachtung laut Anbieter. `null`, wenn er keinen liefert. */
  readonly observedAt: Date | null;
}

export type MarketRejection =
  /** Der Pool handelt einen anderen Token als den angefragten. */
  | "WRONG_BASE_TOKEN"
  /** Gegen ein Quote-Asset ohne verlaesslichen USD-Anker. */
  | "UNUSABLE_QUOTE"
  | "NO_PRICE_REPORTED"
  | "NO_LIQUIDITY_REPORTED"
  | "LIQUIDITY_TOO_LOW"
  | "POOL_TOO_YOUNG"
  | "STALE"
  | "IMPLAUSIBLE_VALUE"
  /** Umsatz im Verhaeltnis zur Liquiditaet ausserhalb des Erklaerbaren. */
  | "TURNOVER_IMPLAUSIBLE"
  /** Handel praktisch nur in eine Richtung. */
  | "ONE_SIDED_FLOW";

export interface RejectedMarket {
  readonly poolAddress: PoolAddress;
  readonly dex: string;
  readonly rejection: MarketRejection;
  readonly detail: string;
  /** Die Kennzahlen, die zur Ablehnung gefuehrt haben — fuer die Aufzeichnung. */
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
}

export interface MarketSelectionSettings {
  /**
   * Quote-Assets, gegen die ein Preis ueberhaupt verankert ist.
   *
   * Ein Memecoin-gegen-Memecoin-Pool hat keinen belastbaren USD-Preis: beide
   * Seiten bewegen sich, und der gemeldete Dollarwert haengt an der Bewertung
   * der Gegenseite. Fuer die Historie mag das interessant sein; eine
   * Einstiegsentscheidung traegt es nicht.
   *
   * Bewusst als Konfiguration und nicht als feste Liste im Code: welche Assets
   * als Anker taugen, ist eine Marktfrage und aendert sich.
   */
  readonly allowedQuoteMints: readonly Mint[];
  readonly minLiquidityUsd: number;
  /**
   * Wie jung ein Pool sein darf.
   *
   * Sehr junge Pools sind nicht per se schlecht — sie sind schlecht *messbar*.
   * 24h-Volumen eines zwei Minuten alten Pools ist keine Tagesaussage, und
   * jede darauf gebaute Kennzahl behauptet eine Historie, die es nicht gibt.
   */
  readonly minPoolAgeSeconds: number;
  readonly maxAgeSeconds: number;
  /**
   * Obergrenze fuer Umschlag (24h-Volumen geteilt durch Liquiditaet).
   *
   * **Plausibilitaetsgrenze, kein Strategieparameter.** Bei Memecoins ist
   * hoher Umschlag normal — das Zehnfache der Liquiditaet an einem Tag ist
   * nichts Besonderes. Was hier gefangen werden soll, ist die Groessenordnung
   * darueber: ein Pool mit 5 000 USD Liquiditaet und 2 Mio. USD Tagesvolumen
   * behauptet, sein gesamter Bestand sei 400-mal umgeschlagen worden. Das ist
   * kein Markt, das ist eine Schleife.
   *
   * Der Wert ist bewusst hoch angesetzt und ausdruecklich nicht kalibriert.
   * Ihn aus Backtests abzuleiten waere Optimierung auf Vergangenheit.
   */
  readonly maxTurnoverRatio: number;
  /**
   * Ab welchem Tagesvolumen die Einseitigkeit ueberhaupt geprueft wird.
   *
   * Unterhalb davon ist ein 30:0-Verhaeltnis schlicht wenig Handel und kein
   * Befund. Die Pruefung dort anzuwenden hiesse, Rauschen als Manipulation zu
   * lesen.
   */
  readonly oneSidedFlowMinVolumeUsd: number;
  /** Anteil einer Seite, ab dem der Fluss als einseitig gilt. */
  readonly oneSidedFlowThreshold: number;
}

/**
 * Konservative Vorgaben. Alle sind Sicherheitsgrenzen, keine Strategie.
 *
 * `minLiquidityUsd` und `maxAgeSeconds` stimmen absichtlich mit
 * `DEFAULT_QUALITY_THRESHOLDS` ueberein: dieselbe Frage darf nicht zwei
 * Antworten haben, je nachdem, welche Datei sie stellt.
 */
export const DEFAULT_MARKET_SELECTION: Omit<MarketSelectionSettings, "allowedQuoteMints"> = {
  minLiquidityUsd: 5_000,
  minPoolAgeSeconds: 15 * 60,
  maxAgeSeconds: 120,
  maxTurnoverRatio: 50,
  oneSidedFlowMinVolumeUsd: 10_000,
  oneSidedFlowThreshold: 0.98,
};

export interface MarketSelectionInput {
  /** Der Token, fuer den ein Markt gesucht wird. */
  readonly mint: Mint;
  readonly candidates: readonly MarketCandidate[];
  /** Jetzt — fuer Alter und Frische. Nie `new Date()` in dieser Datei. */
  readonly now: Date;
  readonly settings: MarketSelectionSettings;
}

export interface MarketSelection {
  readonly chosen: MarketCandidate | null;
  /** Warum dieser — in einem Satz, ohne Kenntnis des Codes lesbar. */
  readonly reason: string;
  /** Alle Kandidaten, die es durch die Ausschluesse geschafft haben, in Rangfolge. */
  readonly ranked: readonly MarketCandidate[];
  readonly rejected: readonly RejectedMarket[];
  /** Wann die Auswahl getroffen wurde. Gehoert in die Aufzeichnung. */
  readonly selectedAt: Date;
}

/**
 * Waehlt den Markt, auf dem Analyse und simulierte Ausfuehrung stattfinden.
 *
 * ### Warum Liquiditaet und nicht Volumen den Ausschlag gibt
 *
 * Volumen ist die manipulierbarste Zahl in diesem Datensatz — zwei Wallets
 * erzeugen beliebig viel davon, und bei Memecoins tun sie das auch. Liquiditaet
 * ist teurer zu faelschen: sie muss tatsaechlich im Pool liegen.
 *
 * Wichtiger noch: Liquiditaet ist die Groesse, die den **Ausstieg** bestimmt.
 * Der teuerste Fehler bei Memecoins ist nicht ein schlechter Einstieg, sondern
 * eine Position, die der Markt nicht zurueckkauft. Ein Pool mit hohem Volumen
 * und duenner Liquiditaet ist genau die Falle, in die eine volumenbasierte
 * Auswahl laeuft.
 *
 * Volumen bleibt zweites Kriterium — es trennt zwei aehnlich tiefe Pools
 * danach, wo tatsaechlich gehandelt wird.
 *
 * ### Warum die Pool-Adresse den letzten Ausschlag gibt
 *
 * Bei exakt gleichen Kennzahlen entscheidet der lexikografisch kleinere
 * Adressstring. Das ist willkuerlich — und genau deshalb richtig: die
 * Alternative waere die Reihenfolge der Anbieterantwort, und die ist ebenso
 * willkuerlich, aber nicht reproduzierbar. Ein Backtest, der die Auswahl nicht
 * nachstellen kann, misst etwas anderes als der Live-Betrieb.
 */
export function selectMarket(input: MarketSelectionInput): MarketSelection {
  const { settings, now } = input;
  const rejected: RejectedMarket[] = [];
  const survivors: MarketCandidate[] = [];

  const reject = (
    c: MarketCandidate,
    rejection: MarketRejection,
    detail: string,
  ): void => {
    rejected.push({
      poolAddress: c.poolAddress,
      dex: c.dex,
      rejection,
      detail,
      liquidityUsd: c.liquidityUsd,
      volume24hUsd: c.volume24hUsd,
    });
  };

  for (const c of input.candidates) {
    // 1. Identitaet zuerst. Ein Pool, der einen anderen Token handelt, ist kein
    //    schlechter Markt fuer unseren Token — er ist nicht unser Markt. Das
    //    ungeprueft durchzulassen hiesse, Anbieterdaten die Zuordnung
    //    entscheiden zu lassen.
    if (c.baseMint !== input.mint) {
      reject(c, "WRONG_BASE_TOKEN", `Pool handelt ${c.baseMint}, gesucht war ${input.mint}.`);
      continue;
    }

    if (!settings.allowedQuoteMints.includes(c.quoteMint)) {
      reject(
        c,
        "UNUSABLE_QUOTE",
        `Quote ${c.quoteMint} ist kein zugelassener Anker — der USD-Preis haengt an der Gegenseite.`,
      );
      continue;
    }

    // 2. Frische vor allen Zahlen: eine veraltete Beobachtung ist keine
    //    schlechte Kennzahl, sondern keine Kennzahl.
    if (c.observedAt === null) {
      reject(c, "STALE", "Anbieter liefert keinen Beobachtungszeitpunkt.");
      continue;
    }
    const ageSeconds = (now.getTime() - c.observedAt.getTime()) / 1_000;
    if (ageSeconds > settings.maxAgeSeconds) {
      reject(c, "STALE", `Beobachtung ${ageSeconds.toFixed(0)} s alt.`);
      continue;
    }

    // 3. Vorhandensein vor Groesse. Fehlend und zu klein sind zwei Befunde.
    if (c.priceUsd === null) {
      reject(c, "NO_PRICE_REPORTED", "Kein Preis gemeldet. Unbekannt, nicht null.");
      continue;
    }
    if (c.liquidityUsd === null) {
      reject(c, "NO_LIQUIDITY_REPORTED", "Keine Liquiditaet gemeldet. Unbekannt, nicht leer.");
      continue;
    }

    // 4. Plausibilitaet vor Schwellen: ein negativer Wert ist ein
    //    Anbieterfehler, keine Marktaussage.
    const implausible = firstImplausible(c);
    if (implausible !== null) {
      reject(c, "IMPLAUSIBLE_VALUE", implausible);
      continue;
    }

    if (c.liquidityUsd < settings.minLiquidityUsd) {
      reject(
        c,
        "LIQUIDITY_TOO_LOW",
        `${c.liquidityUsd.toFixed(0)} USD, verlangt sind ${String(settings.minLiquidityUsd)} USD.`,
      );
      continue;
    }

    // 5. Pool-Alter. Ohne Entstehungszeitpunkt ist das Alter unbekannt — und
    //    unbekannt wird hier nicht zu „alt genug" umgedeutet.
    if (c.pairCreatedAt === null) {
      reject(c, "POOL_TOO_YOUNG", "Kein Entstehungszeitpunkt — Alter unbekannt.");
      continue;
    }
    const poolAgeSeconds = (now.getTime() - c.pairCreatedAt.getTime()) / 1_000;
    if (poolAgeSeconds < settings.minPoolAgeSeconds) {
      reject(
        c,
        "POOL_TOO_YOUNG",
        `Pool ${poolAgeSeconds.toFixed(0)} s alt, verlangt sind ${String(settings.minPoolAgeSeconds)} s.`,
      );
      continue;
    }

    // 6. Manipulationsindikatoren. Beide sind Verdachtsmomente aus der
    //    Datenlage selbst — keine Behauptung ueber Absichten, und ausdruecklich
    //    keine „Smart Money"-Aussage.
    if (c.volume24hUsd !== null && c.liquidityUsd > 0) {
      const turnover = c.volume24hUsd / c.liquidityUsd;
      if (turnover > settings.maxTurnoverRatio) {
        reject(
          c,
          "TURNOVER_IMPLAUSIBLE",
          `Umschlag ${turnover.toFixed(0)}x der Liquiditaet in 24 h, Grenze ${String(settings.maxTurnoverRatio)}x.`,
        );
        continue;
      }
    }

    const oneSided = oneSidedFlow(c, settings);
    if (oneSided !== null) {
      reject(c, "ONE_SIDED_FLOW", oneSided);
      continue;
    }

    survivors.push(c);
  }

  const ranked = [...survivors].sort(compareMarkets);
  const chosen = ranked[0] ?? null;

  return {
    chosen,
    reason:
      chosen === null
        ? input.candidates.length === 0
          ? "Keine Maerkte zu diesem Token gemeldet."
          : `Kein Markt bestand die Pruefung: ${summarize(rejected)}.`
        : `${chosen.dex} ${chosen.poolAddress}: tiefste zugelassene Liquiditaet ` +
          `(${(chosen.liquidityUsd ?? 0).toFixed(0)} USD) von ${String(ranked.length)} ` +
          `zugelassenen, ${String(rejected.length)} ausgeschlossen.`,
    ranked,
    rejected,
    selectedAt: now,
  };
}

/**
 * Die Rangfolge unter den zugelassenen Maerkten.
 *
 * Ausgelagert, weil sie fuer sich pruefbar sein muss: eine Sortierung, die von
 * der Eingabereihenfolge abhaengt, faellt in einem Test mit vertauschten
 * Kandidaten sofort auf — und sonst nie.
 */
function compareMarkets(a: MarketCandidate, b: MarketCandidate): number {
  const liq = (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0);
  if (liq !== 0) return liq;
  const vol = (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0);
  if (vol !== 0) return vol;
  // Letzte Instanz: die Adresse. Willkuerlich, aber reproduzierbar.
  return a.poolAddress < b.poolAddress ? -1 : a.poolAddress > b.poolAddress ? 1 : 0;
}

/** Der erste Wert, den es so nicht geben kann — oder `null`. */
function firstImplausible(c: MarketCandidate): string | null {
  for (const [name, value] of [
    ["priceUsd", c.priceUsd],
    ["liquidityUsd", c.liquidityUsd],
    ["volume24hUsd", c.volume24hUsd],
    ["buyCount24h", c.buyCount24h],
    ["sellCount24h", c.sellCount24h],
  ] as const) {
    if (value === null) continue;
    if (!Number.isFinite(value)) return `${name} ist kein endlicher Zahlenwert.`;
    if (value < 0) return `${name} ist negativ (${String(value)}).`;
  }
  if (c.priceUsd === 0) return "priceUsd ist 0 — kein handelbarer Preis.";
  return null;
}

/**
 * Handel praktisch nur in eine Richtung.
 *
 * Ein Pool, in dem 24 h lang gekauft und nie verkauft wurde, ist entweder ein
 * Fehler in den Daten oder ein Markt, aus dem niemand herauskommt. Beides ist
 * ein Grund, ihn nicht zur Grundlage einer Position zu machen.
 *
 * Gibt `null` zurueck, wenn die Zaehler fehlen: unbekannt ist kein Befund.
 */
function oneSidedFlow(
  c: MarketCandidate,
  settings: MarketSelectionSettings,
): string | null {
  if (c.buyCount24h === null || c.sellCount24h === null) return null;
  if (c.volume24hUsd === null || c.volume24hUsd < settings.oneSidedFlowMinVolumeUsd) return null;

  const total = c.buyCount24h + c.sellCount24h;
  if (total === 0) return null;

  const buyShare = c.buyCount24h / total;
  if (buyShare >= settings.oneSidedFlowThreshold) {
    return `${(buyShare * 100).toFixed(1)} % der Trades sind Kaeufe — kein zweiseitiger Markt.`;
  }
  const sellShare = c.sellCount24h / total;
  if (sellShare >= settings.oneSidedFlowThreshold) {
    return `${(sellShare * 100).toFixed(1)} % der Trades sind Verkaeufe — Ausstiegswelle.`;
  }
  return null;
}

/** Die Ablehnungsgruende gezaehlt, fuer einen lesbaren Satz. */
function summarize(rejected: readonly RejectedMarket[]): string {
  const counts = new Map<MarketRejection, number>();
  for (const r of rejected) counts.set(r.rejection, (counts.get(r.rejection) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}=${String(n)}`).join(", ");
}
