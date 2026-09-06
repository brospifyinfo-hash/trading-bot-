import { isBase58Address } from "@sae/core";

import type { Database } from "../client";
import { tokens } from "../schema/tokens";

/**
 * Die Watchlist: Token, die jemand ausdruecklich benannt hat.
 *
 * Sie ist **nicht** die Discovery und soll sie auch nicht ersetzen. Der
 * Unterschied ist inhaltlich, nicht technisch:
 *
 * - **Discovery** findet Token, die niemand kannte. Sie braucht eine Quelle,
 *   die neue Paare meldet, und die gibt es noch nicht (die Rolle ist ein
 *   ausdruecklicher Platzhalter).
 * - **Watchlist** ist Konfiguration. Jemand hat entschieden, diese Adressen zu
 *   beobachten, und traegt sie ein.
 *
 * Der Grund, warum es sie gibt: ohne einen einzigen Token in der Tabelle
 * meldet `refreshMarketData` dauerhaft `NO_TOKENS`, und die gesamte Kette
 * dahinter — Snapshots, Historie, Features, Paper — bleibt leer. Ein Bot, der
 * korrekt nichts tut, ist schwer von einem kaputten zu unterscheiden.
 *
 * Was hier ausdruecklich NICHT passiert: es wird nichts ueber diese Token
 * behauptet. Sie bekommen `state = DISCOVERED`, keine Dezimalstellen (die
 * stehen im Mint-Account, nicht in einer Konfiguration), keinen Preis, keine
 * Bewertung. Ob sie handelbar sind, entscheidet dieselbe Kette wie fuer jeden
 * anderen Token auch.
 */

/** Woher diese Token stammen — sichtbar in `tokens.discovery_source`. */
export const WATCHLIST_SOURCE = "WATCHLIST";

export interface WatchlistParse {
  readonly mints: readonly string[];
  /** Eintraege, die keine Solana-Adresse sind. Sie werden gemeldet, nicht geschluckt. */
  readonly rejected: readonly string[];
}

/**
 * Zerlegt die Konfiguration.
 *
 * Ungueltige Eintraege werden nicht stillschweigend uebergangen: ein Tippfehler
 * in einer Adresse soll auffallen, und zwar beim Start und nicht dadurch, dass
 * ein Token nie Daten bekommt.
 */
export function parseWatchlist(raw: string | undefined): WatchlistParse {
  if (raw === undefined || raw.trim() === "") return { mints: [], rejected: [] };

  const mints: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (!isBase58Address(value)) {
      rejected.push(value);
      continue;
    }
    // Dieselbe Adresse zweimal ist kein Fehler, nur Redundanz.
    if (seen.has(value)) continue;
    seen.add(value);
    mints.push(value);
  }

  return { mints, rejected };
}

export interface WatchlistResult {
  /** Neu angelegt. */
  readonly added: number;
  /** Waren schon da — die Watchlist wird bei jedem Start angewendet. */
  readonly known: number;
  readonly rejected: readonly string[];
}

/**
 * Legt die Watchlist-Token an, die noch fehlen.
 *
 * `onConflictDoNothing` auf `mint`: die Funktion laeuft bei jedem Start des
 * Schedulers, und ein bereits entdeckter Token darf dadurch weder dupliziert
 * noch zurueckgesetzt werden. Ein Token, das die Discovery spaeter selbst
 * findet, behaelt seine urspruengliche Herkunft.
 */
export async function ensureWatchlistTokens(input: {
  readonly db: Database;
  readonly raw: string | undefined;
}): Promise<WatchlistResult> {
  const { mints, rejected } = parseWatchlist(input.raw);
  if (mints.length === 0) return { added: 0, known: 0, rejected };

  const inserted = await input.db
    .insert(tokens)
    .values(
      mints.map((mint) => ({
        mint,
        discoverySource: WATCHLIST_SOURCE,
        // decimals bleibt null: sie stehen im Mint-Account on-chain, nicht in
        // einer Konfiguration. Eine geratene Dezimalstelle waere im
        // Ausfuehrungspfad ein Betragsfehler um Zehnerpotenzen.
      })),
    )
    .onConflictDoNothing({ target: tokens.mint })
    .returning({ mint: tokens.mint });

  return {
    added: inserted.length,
    known: mints.length - inserted.length,
    rejected,
  };
}
