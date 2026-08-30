import type { Mint } from "@sae/core";
import type { DiscoveredToken } from "./types";

/**
 * Deduplizierung.
 *
 * Mehrere Quellen melden denselben Token, und dieselbe Quelle meldet ihn bei
 * jedem Abruf erneut. Ohne Deduplizierung laeuft die teure Anreicherung
 * hundertfach fuer denselben Mint — das ist kein Schoenheitsfehler, sondern der
 * schnellste Weg, ein Provider-Budget zu verbrennen.
 *
 * Der Speicher ist eine Schnittstelle: in Produktion die Tabelle `tokens` mit
 * ihrem Unique-Index auf `mint`, im Test eine Menge. Die Datenbank bleibt die
 * letzte Instanz — zwei Discovery-Worker koennen gleichzeitig denselben Token
 * finden, und dann entscheidet der Index, nicht die Anwendung.
 */
export interface SeenStore {
  has(mint: Mint): Promise<boolean>;
  /** Gibt zurueck, ob der Mint neu war. Muss atomar sein. */
  add(mint: Mint, at: Date): Promise<boolean>;
}

export class InMemorySeenStore implements SeenStore {
  readonly #seen = new Map<string, Date>();

  async has(mint: Mint): Promise<boolean> {
    return this.#seen.has(mint);
  }

  async add(mint: Mint, at: Date): Promise<boolean> {
    if (this.#seen.has(mint)) return false;
    this.#seen.set(mint, at);
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }
}

export interface DedupResult {
  readonly fresh: readonly DiscoveredToken[];
  readonly duplicates: number;
  /** Mints, die von mehreren Quellen gleichzeitig gemeldet wurden. */
  readonly multiSourceMints: readonly Mint[];
}

/**
 * Filtert bereits bekannte Tokens heraus.
 *
 * Meldungen mehrerer Quellen zum selben Mint werden zusammengefasst, aber
 * festgehalten: dass drei unabhaengige Quellen denselben Token gleichzeitig
 * melden, ist selbst eine Information — sie geht spaeter in die Priorisierung
 * ein, NICHT in die Bewertung. Aufmerksamkeit ist kein Qualitaetsmerkmal.
 */
export async function deduplicate(
  batch: readonly DiscoveredToken[],
  store: SeenStore,
): Promise<DedupResult> {
  const byMint = new Map<string, DiscoveredToken[]>();
  for (const token of batch) {
    const list = byMint.get(token.mint) ?? [];
    list.push(token);
    byMint.set(token.mint, list);
  }

  const fresh: DiscoveredToken[] = [];
  const multiSourceMints: Mint[] = [];
  let duplicates = 0;

  for (const [mint, tokens] of byMint) {
    const distinctSources = new Set(tokens.map((t) => t.source));
    if (distinctSources.size > 1) multiSourceMints.push(mint as Mint);

    // Aeltester Zeitstempel gewinnt: wir wollen wissen, wann wir den Token
    // ZUERST gesehen haben, nicht wann ihn die letzte Quelle gemeldet hat.
    const earliest = tokens.reduce((a, b) => (a.observedAt <= b.observedAt ? a : b));
    const isNew = await store.add(earliest.mint, earliest.observedAt);
    if (isNew) {
      fresh.push(earliest);
    } else {
      duplicates += tokens.length;
    }
  }

  return { fresh, duplicates, multiSourceMints };
}
