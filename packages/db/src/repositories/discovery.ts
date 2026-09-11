import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "../client";
import { tokens, tokenSecurity } from "../schema/tokens";

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
  /**
   * Wann WIR den Token zuerst gesehen haben.
   *
   * Ausdruecklich nicht das Alter des Pools: ein spaet gefundener Token ist
   * aelter, als diese Zahl sagt. Sie heisst „seit wann beobachten wir ihn" und
   * geht so auch in `tokenAgeSeconds` des Feature-Vektors ein.
   */
  readonly firstSeenAt: Date;
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
    .select({ id: tokens.id, mint: tokens.mint, firstSeenAt: tokens.firstSeenAt })
    .from(tokens)
    .where(and(isNull(tokens.blacklistedAt), ne(tokens.state, "REJECTED")))
    .orderBy(desc(tokens.firstSeenAt))
    .limit(limit);
}

/**
 * Gibt es ueberhaupt Bestand zu ueberwachen?
 *
 * Eine Abfrage fuer drei Fragen, und sie beantwortet die teuerste Zeile des
 * Betriebs: von 26.308 Auftraegen am Tag entfielen 17.280 auf die
 * Ueberwachung von Positionen, Paper-Positionen und Gelegenheiten, die es
 * alle nicht gab.
 *
 * `EXISTS` statt `COUNT`: die Zahl interessiert niemanden, nur ob ueberhaupt
 * etwas da ist — und `EXISTS` hoert beim ersten Treffer auf zu suchen.
 *
 * Alle drei Tabellen fuehren `closed_at`; offen heisst ueberall dasselbe.
 */
export async function hasOpenWork(db: Database): Promise<boolean> {
  const rows = await db.execute<{ any_open: boolean }>(
    sql`select (
          exists (select 1 from positions where closed_at is null)
          or exists (select 1 from paper_positions where closed_at is null)
          or exists (select 1 from opportunities where closed_at is null)
        ) as any_open`,
  );
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const first = list[0] as { any_open?: boolean } | undefined;
  return first?.any_open === true;
}

/**
 * Was das Mint-Lesen ueber einen Token ergeben hat.
 *
 * Die Discovery liest fuer jeden Kandidaten Mint- und Freeze-Autoritaet und
 * benutzt sie fuer das Vorsieb — danach wurde das Ergebnis weggeworfen. Damit
 * fehlten zwei Felder im Sicherheitsteil des Feature-Vektors, obwohl sie
 * bereits bezahlt waren.
 */
export interface AuthorityRecord {
  readonly mint: string;
  readonly mintAuthorityActive: boolean;
  readonly freezeAuthorityActive: boolean;
}

/**
 * Schreibt Autoritaeten fort — als Zeitreihe, aber nur bei AENDERUNG.
 *
 * Autoritaeten aendern sich selten und die Discovery laeuft alle 30 Sekunden.
 * Bei jedem Takt eine Zeile zu schreiben ergaebe 2.880 identische Zeilen je
 * Token und Tag — genau der Leerlauf, der im September das Datenkontingent
 * aufgebraucht hat (DECISIONS §101), nur in Schreibrichtung.
 *
 * Eine neue Zeile entsteht deshalb nur, wenn es noch keine gibt oder sich
 * etwas geaendert hat. Und eine Aenderung IST hier ein Ereignis: wer eine
 * Mint-Autoritaet wieder aktiviert, hat gerade die Voraussetzung fuer
 * beliebiges Nachpraegen geschaffen.
 */
export async function recordAuthorities(
  db: Database,
  records: readonly AuthorityRecord[],
  checkVersion: string,
  at: Date,
): Promise<number> {
  if (records.length === 0) return 0;

  let written = 0;
  for (const record of records) {
    const [token] = await db
      .select({ id: tokens.id })
      .from(tokens)
      .where(eq(tokens.mint, record.mint))
      .limit(1);
    if (token === undefined) continue;

    const [latest] = await db
      .select({
        mintAuthorityActive: tokenSecurity.mintAuthorityActive,
        freezeAuthorityActive: tokenSecurity.freezeAuthorityActive,
      })
      .from(tokenSecurity)
      .where(eq(tokenSecurity.tokenId, token.id))
      .orderBy(desc(tokenSecurity.observedAt))
      .limit(1);

    if (
      latest !== undefined &&
      latest.mintAuthorityActive === record.mintAuthorityActive &&
      latest.freezeAuthorityActive === record.freezeAuthorityActive
    ) {
      continue;
    }

    await db.insert(tokenSecurity).values({
      tokenId: token.id,
      observedAt: at,
      checkVersion,
      mintAuthorityActive: record.mintAuthorityActive,
      freezeAuthorityActive: record.freezeAuthorityActive,
    });
    written += 1;
  }
  return written;
}

/**
 * Tokens, die einen Sicherheitsbefund brauchen.
 *
 * „Brauchen" heisst: noch nie einen gehabt, oder der letzte ist aelter als
 * `staleBefore`. Absteigend nach Erstkontakt — neue Tokens zuerst, weil bei
 * ihnen die Entscheidung ansteht und bei den alten laengst gefallen ist.
 *
 * Das `LEFT JOIN` auf den juengsten Befund statt eines `NOT IN`: so faellt in
 * derselben Abfrage auch der veraltete Fall heraus, und es bleibt bei einer
 * Abfrage je Lauf.
 */
export async function selectTokensNeedingSecurity(
  db: Database,
  limit: number,
  staleBefore: Date,
): Promise<readonly TrackedToken[]> {
  const rows = await db.execute<{ id: string; mint: string; first_seen_at: Date }>(sql`
    select t.id, t.mint, t.first_seen_at
    from tokens t
    left join lateral (
      select s.observed_at
      from token_security s
      where s.token_id = t.id
      order by s.observed_at desc
      limit 1
    ) letzter on true
    where t.blacklisted_at is null
      and t.state <> 'REJECTED'
      and (
        letzter.observed_at is null
        or letzter.observed_at < ${staleBefore.toISOString()}::timestamptz
      )
    order by t.first_seen_at desc
    limit ${limit}
  `);
  // Wie in `hasOpenWork`: `execute` liefert je nach Treiber die Zeilen direkt
  // oder in `.rows`. Beide Formen kommen im Betrieb vor (PGlite im Test,
  // postgres.js in Produktion), und eine davon anzunehmen hiesse, den Test
  // gruen zu halten und die Produktion leer laufen zu lassen.
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return list.map((raw) => {
    const row = raw as { id: string; mint: string; first_seen_at: Date | string };
    return {
      id: row.id,
      mint: row.mint,
      firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at : new Date(row.first_seen_at),
    };
  });
}

/** Ein vollstaendiger Sicherheitsbefund, wie ihn ein Anbieter liefert. */
export interface SecurityFinding {
  readonly tokenId: string;
  readonly checkVersion: string;
  readonly mintAuthorityActive: boolean | null;
  readonly freezeAuthorityActive: boolean | null;
  readonly top10HolderSharePct: number | null;
  readonly topHolderSharePct: number | null;
  readonly devHoldingPct: number | null;
  /** Normierter Anbieter-Score. Kein eigenes Urteil. */
  readonly securityScore: number | null;
  /**
   * Was der Anbieter sonst noch meldete.
   *
   * Bewusst frei geformt: hier landen Messungen, fuer die es (noch) keine
   * Spalte gibt — etwa der LP-Sperranteil. Sie gehen dadurch nicht verloren,
   * und niemand muss dafuer eine Schwelle erfinden.
   */
  readonly findings: Readonly<Record<string, unknown>>;
}

/**
 * Schreibt einen Sicherheitsbefund fort.
 *
 * Anders als `recordAuthorities` IMMER eine neue Zeile: ein Befund ist eine
 * Messung zu einem Zeitpunkt, und die Zeitreihe ist der Zweck. Der Takt sorgt
 * dafuer, dass das selten genug passiert — alle paar Stunden je Token, nicht
 * alle 20 Sekunden.
 */
export async function recordSecurityFinding(
  db: Database,
  finding: SecurityFinding,
  at: Date,
): Promise<void> {
  await db.insert(tokenSecurity).values({
    tokenId: finding.tokenId,
    observedAt: at,
    checkVersion: finding.checkVersion,
    mintAuthorityActive: finding.mintAuthorityActive,
    freezeAuthorityActive: finding.freezeAuthorityActive,
    top10HolderSharePct: finding.top10HolderSharePct,
    topHolderSharePct: finding.topHolderSharePct,
    devHoldingPct: finding.devHoldingPct,
    securityScore: finding.securityScore,
    findings: finding.findings,
  });
}
