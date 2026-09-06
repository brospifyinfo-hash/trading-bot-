import { and, desc, eq, isNull, ne } from "drizzle-orm";

import type { Database } from "../client";
import { tokens } from "../schema/tokens";

/**
 * Die Datenbankseite der Token-Entdeckung.
 *
 * Zwei Dinge liegen hier, und beide gehoeren zusammen:
 *
 * 1. Der Speicher, den die Deduplizierung braucht. Sein Kommentar in
 *    `packages/discovery/src/dedup.ts` benennt ihn ausdruecklich: „in
 *    Produktion die Tabelle `tokens` mit ihrem Unique-Index auf `mint`". Die
 *    Datenbank ist die letzte Instanz — zwei Discovery-Laeufe koennen
 *    gleichzeitig denselben Token finden, und dann entscheidet der Index und
 *    nicht die Anwendung.
 * 2. Was aus dem Vorsieb an der Zeile stehen bleibt: der Zustand.
 *
 * Getrennt vom Discovery-Paket, weil dieses bewusst nichts von der Datenbank
 * weiss. Die Klasse hier erfuellt die Schnittstelle `SeenStore` strukturell —
 * ohne sie zu importieren und damit ohne eine neue Paketkante.
 */

/**
 * Herkunft, wenn der Lauf sie nicht mitgeliefert hat.
 *
 * Sollte nie in der Tabelle stehen: jeder Mint, der bis hierher kommt, wurde
 * von einer Quelle gemeldet, und die Quelle wird mitgefuehrt. Der Wert ist ein
 * sichtbarer Fehlerabdruck, kein Platzhalter — taucht er auf, hat der Aufrufer
 * die Zuordnung verloren.
 */
export const UNRECORDED_DISCOVERY_SOURCE = "UNRECORDED";

/**
 * „Kennen wir diesen Mint schon?"
 *
 * `add` faellt mit `onConflictDoNothing` auf den Unique-Index zurueck. Das ist
 * die geforderte Atomaritaet: nicht „pruefen, dann schreiben" (dazwischen
 * passt ein zweiter Prozess), sondern ein einziges Statement, dessen Rueckgabe
 * beantwortet, wer zuerst da war.
 *
 * Die Zeile entsteht VOR dem Vorsieb. Das ist Absicht: was das System gesehen
 * hat, soll es auch dann noch wissen, wenn es den Token gleich darauf
 * verwirft — sonst faende es ihn beim naechsten Lauf erneut, fragte erneut
 * Marktdaten ab und verwuerfe erneut. Der Zustand der Zeile sagt anschliessend,
 * was das Sieb entschieden hat.
 */
export class TokenSeenStore {
  readonly #db: Database;
  readonly #sourceOf: (mint: string) => string;
  readonly #added: string[] = [];

  constructor(db: Database, sourceOf: (mint: string) => string) {
    this.#db = db;
    this.#sourceOf = sourceOf;
  }

  async has(mint: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: tokens.id })
      .from(tokens)
      .where(eq(tokens.mint, mint))
      .limit(1);
    return row !== undefined;
  }

  async add(mint: string, at: Date): Promise<boolean> {
    const inserted = await this.#db
      .insert(tokens)
      .values({
        mint,
        discoverySource: this.#sourceOf(mint),
        firstSeenAt: at,
        // decimals bleibt null: sie stehen im Mint-Account on-chain, nicht in
        // einer Marktdaten-Antwort. Eine geratene Dezimalstelle waere im
        // Ausfuehrungspfad ein Betragsfehler um Zehnerpotenzen.
      })
      .onConflictDoNothing({ target: tokens.mint })
      .returning({ mint: tokens.mint });

    const isNew = inserted.length > 0;
    if (isNew) this.#added.push(mint);
    return isNew;
  }

  /** Die Mints, die DIESER Lauf angelegt hat. Grundlage der Zustandspflege. */
  get added(): readonly string[] {
    return this.#added;
  }
}

/**
 * Der Zustand, den das Vorsieb hinterlaesst.
 *
 * `SCREENING` und nicht `CANDIDATE`: das Vorsieb ist ausdruecklich grob und
 * bewertet nicht. Ein Token, das es passiert hat, ist nicht gut — es ist nur
 * nicht offensichtlich ungeeignet. `CANDIDATE` behauptete eine Bewertung, die
 * niemand vorgenommen hat.
 */
export type DiscoveryOutcomeState = "SCREENING" | "WATCHLIST" | "REJECTED";

export interface DiscoveryOutcome {
  readonly mint: string;
  readonly state: DiscoveryOutcomeState;
  readonly symbol: string | null;
  readonly launchedAt: Date | null;
  readonly discoverySource: string;
}

/**
 * Schreibt fest, was das Vorsieb entschieden hat.
 *
 * Die Bedingung `state = 'DISCOVERED'` ist der Schutz davor, einen Token
 * zurueckzuwerfen, der laengst weiter ist. Ein Token aus der Watchlist, der
 * bereits `SCORED` ist und den die Discovery ein zweites Mal meldet, darf
 * nicht auf `SCREENING` zurueckfallen — er wuerde die Kette von vorn
 * durchlaufen und dabei seine Bewertung verlieren.
 *
 * `symbol` und `launchedAt` werden nur gesetzt, wenn die Quelle sie geliefert
 * hat. Ein `null` aus einem ausgefallenen Anreicherungsaufruf duerfte einen
 * bereits bekannten Wert nicht loeschen.
 */
export async function applyDiscoveryOutcomes(input: {
  readonly db: Database;
  readonly outcomes: readonly DiscoveryOutcome[];
}): Promise<number> {
  let updated = 0;
  for (const outcome of input.outcomes) {
    const rows = await input.db
      .update(tokens)
      .set({
        state: outcome.state,
        discoverySource: outcome.discoverySource,
        ...(outcome.symbol !== null ? { symbol: outcome.symbol } : {}),
        ...(outcome.launchedAt !== null ? { launchedAt: outcome.launchedAt } : {}),
      })
      .where(and(eq(tokens.mint, outcome.mint), eq(tokens.state, "DISCOVERED")))
      .returning({ mint: tokens.mint });
    updated += rows.length;
  }
  return updated;
}

/** Steht dieser Mint auf der Sperrliste? */
export async function isTokenBlacklisted(db: Database, mint: string): Promise<boolean> {
  const [row] = await db
    .select({ blacklistedAt: tokens.blacklistedAt })
    .from(tokens)
    .where(eq(tokens.mint, mint))
    .limit(1);
  return row !== undefined && row.blacklistedAt !== null;
}

export interface TrackedToken {
  readonly id: string;
  readonly mint: string;
}

/**
 * Die Tokens, fuer die Marktdaten geholt werden.
 *
 * Bis die Discovery lief, war die Tabelle klein und eine ungefilterte Auswahl
 * unschaedlich. Mit einer laufenden Discovery ist sie es nicht mehr: jeder
 * Durchlauf legt Zeilen an, die das Vorsieb im selben Durchlauf verworfen hat.
 * Sie weiter abzufragen kostet Anbieterbudget fuer Tokens, gegen die das
 * System sich bereits entschieden hat.
 *
 * Deshalb zwei Ausschluesse und eine Ordnung:
 *
 * - Gesperrte Tokens (`blacklisted_at`) sind endgueltig draussen.
 * - `REJECTED` ist die Entscheidung des Vorsiebs; sie zu ignorieren hiesse,
 *   sie nicht getroffen zu haben. `WATCHLIST` bleibt ausdruecklich drin — das
 *   ist die Gruppe, die spaeter die Kontrollgruppe bildet.
 * - Juengste zuerst. Ohne Ordnung entscheidet PostgreSQL, welche Zeilen der
 *   Deckel abschneidet, und die Auswahl kann sich zwischen zwei Laeufen
 *   aendern — was den Wiederaufnahme-Checkpoint des Aufrufers untergraebt.
 */
export async function selectTrackedTokens(
  db: Database,
  limit: number,
): Promise<readonly TrackedToken[]> {
  return db
    .select({ id: tokens.id, mint: tokens.mint })
    .from(tokens)
    .where(and(isNull(tokens.blacklistedAt), ne(tokens.state, "REJECTED")))
    .orderBy(desc(tokens.firstSeenAt))
    .limit(limit);
}
