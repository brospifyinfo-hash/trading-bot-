import { isBase58Address } from "@sae/core";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "../client";
import { copyWallets } from "../schema/settings";

/**
 * Die Wallets, deren Trades kopiert werden.
 *
 * Der Betreiber klebt Adressen ein — meistens mehrere auf einmal, und nicht
 * immer sauber: eine per Zeile, fuenf durch Kommas getrennt, manchmal ein
 * Solscan-Link. Das alles auf „eine Adresse pro Feld" zu zwingen waere
 * bequemer zu bauen und im Gebrauch eine Schikane.
 *
 * Geprueft wird trotzdem streng. Eine Adresse mit einem Tippfehler ist keine
 * Adresse; sie wuerde hier still als „hat noch nie gehandelt" liegen und
 * monatelang als Eigenschaft der Wallet gelesen werden statt als Fehler bei
 * der Eingabe. Dasselbe Muster wie die stillen Nullen aus §140, §144 und
 * §150.
 */

/** Plausibilitaetsgrenze. Mehr Wallets heisst nicht mehr Erkenntnis. */
export const MAX_COPY_WALLETS = 50;
/** Wie viele Adressen eine einzelne Eingabe hoechstens enthalten darf. */
export const MAX_PASTE_SIZE = 200;

export interface CopyWalletRow {
  readonly address: string;
  readonly label: string | null;
  readonly active: boolean;
  readonly addedAt: Date;
  readonly addedBy: string;
  readonly lastCheckedAt: Date | null;
  readonly copiedCount: number;
}

export interface WalletEntry {
  readonly address: string;
  readonly label: string | null;
}

export interface ParsedWalletList {
  readonly gueltig: readonly WalletEntry[];
  /** Was wie eine Adresse aussah, aber keine ist — woertlich, zum Vergleichen. */
  readonly ungueltig: readonly string[];
  /** Innerhalb DIESER Eingabe doppelt. Kein Fehler, aber es soll sichtbar sein. */
  readonly doppelt: readonly string[];
}

export function isValidWalletAddress(value: unknown): value is string {
  return typeof value === "string" && isBase58Address(value);
}

/** Aus einem Token die Adresse holen: auch wenn ein Link drumherum steht. */
function normalisiere(token: string): string {
  const roh = token.trim().replace(/^[<([{"']+|[>)\]}"',.;:]+$/g, "");
  if (roh.length === 0) return "";
  if (!roh.includes("/")) return roh;
  const ohneQuery = roh.split("?")[0]?.split("#")[0] ?? "";
  const stuecke = ohneQuery.split("/").filter((s) => s.length > 0);
  const treffer = stuecke.filter((s) => isBase58Address(s));
  // Genau eine Adresse im Pfad: die ist gemeint. Mehrere: raten waere hier
  // schlimmer als melden, denn ein falsch kopiertes Vorbild kopiert still
  // fremde Trades.
  return treffer.length === 1 ? treffer[0] ?? "" : roh;
}

/**
 * Was der Betreiber eingeklebt hat, als Liste.
 *
 * Zwei Formen, und die Unterscheidung ist bewusst scharf:
 *
 * - Eine Zeile mit `=` oder `|` ist EIN Eintrag mit Namen:
 *   `7igL… = Alpha-Wallet`.
 * - Jede andere Zeile ist eine LISTE von Adressen, getrennt durch Leerzeichen,
 *   Komma, Semikolon oder Tabulator.
 *
 * Die naheliegende Regel „erstes Wort ist die Adresse, der Rest der Name"
 * waere die Falle: wer fuenf Adressen in eine Zeile klebt, haette vier davon
 * als Namen der ersten gespeichert — und es nicht gemerkt.
 */
export function parseWalletList(eingabe: string): ParsedWalletList {
  const gueltig: WalletEntry[] = [];
  const ungueltig: string[] = [];
  const doppelt: string[] = [];
  const gesehen = new Set<string>();

  const nimm = (kandidat: string, label: string | null): void => {
    const adresse = normalisiere(kandidat);
    if (adresse.length === 0) return;
    if (!isValidWalletAddress(adresse)) {
      if (!ungueltig.includes(adresse)) ungueltig.push(adresse);
      return;
    }
    if (gesehen.has(adresse)) {
      if (!doppelt.includes(adresse)) doppelt.push(adresse);
      return;
    }
    gesehen.add(adresse);
    gueltig.push({ address: adresse, label });
  };

  for (const zeile of eingabe.split(/\r?\n/)) {
    if (zeile.trim().length === 0) continue;
    const trenner = /[=|]/.exec(zeile);
    if (trenner !== null && trenner.index > 0) {
      const adresse = zeile.slice(0, trenner.index);
      const label = zeile.slice(trenner.index + 1).trim().slice(0, 60);
      nimm(adresse, label.length === 0 ? null : label);
      continue;
    }
    for (const token of zeile.split(/[\s,;]+/)) nimm(token, null);
    if (gueltig.length + ungueltig.length > MAX_PASTE_SIZE) break;
  }

  return { gueltig: gueltig.slice(0, MAX_PASTE_SIZE), ungueltig, doppelt };
}

export async function loadCopyWallets(db: Database): Promise<readonly CopyWalletRow[]> {
  return db
    .select({
      address: copyWallets.address,
      label: copyWallets.label,
      active: copyWallets.active,
      addedAt: copyWallets.addedAt,
      addedBy: copyWallets.addedBy,
      lastCheckedAt: copyWallets.lastCheckedAt,
      copiedCount: copyWallets.copiedCount,
    })
    .from(copyWallets)
    .orderBy(asc(copyWallets.addedAt), asc(copyWallets.address));
}

/** Nur die, von denen gerade wirklich kopiert wird. Der Kopierer liest das. */
export async function loadActiveCopyWallets(db: Database): Promise<readonly CopyWalletRow[]> {
  const alle = await loadCopyWallets(db);
  return alle.filter((w) => w.active);
}

export interface AddWalletsResult {
  readonly kind: "OK" | "LIMIT_REACHED";
  /** Neu angelegt. */
  readonly angelegt: readonly string[];
  /** Stand schon drin — Name wurde uebernommen, falls einer mitkam. */
  readonly bekannt: readonly string[];
  /** Nicht angelegt, weil die Obergrenze erreicht war. */
  readonly abgewiesen: readonly string[];
  readonly gesamt: number;
}

/**
 * Legt Wallets an. `onConflictDoNothing` auf der Adresse, nicht ein SELECT
 * davor: zwei gleichzeitige Eingaben bekommen so dasselbe Ergebnis.
 *
 * Ein mitgeschickter Name UEBERSCHREIBT einen vorhandenen nur, wenn er nicht
 * leer ist — wer eine bekannte Adresse ohne Namen erneut einklebt, soll den
 * Namen nicht verlieren.
 */
export async function addCopyWallets(
  db: Database,
  entries: readonly WalletEntry[],
  addedBy: string,
): Promise<AddWalletsResult> {
  const angelegt: string[] = [];
  const bekannt: string[] = [];
  const abgewiesen: string[] = [];

  const vorhanden = await loadCopyWallets(db);
  let platz = MAX_COPY_WALLETS - vorhanden.length;
  const bekannteAdressen = new Set(vorhanden.map((w) => w.address));

  for (const entry of entries) {
    if (bekannteAdressen.has(entry.address)) {
      bekannt.push(entry.address);
      if (entry.label !== null) {
        await db
          .update(copyWallets)
          .set({ label: entry.label })
          .where(eq(copyWallets.address, entry.address));
      }
      continue;
    }
    if (platz <= 0) {
      abgewiesen.push(entry.address);
      continue;
    }
    const inserted = await db
      .insert(copyWallets)
      .values({
        address: entry.address,
        ...(entry.label === null ? {} : { label: entry.label }),
        addedBy,
      })
      .onConflictDoNothing({ target: copyWallets.address })
      .returning({ address: copyWallets.address });
    if (inserted.length === 0) {
      bekannt.push(entry.address);
      continue;
    }
    angelegt.push(entry.address);
    platz -= 1;
  }

  return {
    kind: abgewiesen.length > 0 ? "LIMIT_REACHED" : "OK",
    angelegt, bekannt, abgewiesen,
    gesamt: vorhanden.length + angelegt.length,
  };
}

export async function setCopyWalletActive(
  db: Database,
  address: string,
  active: boolean,
): Promise<boolean> {
  if (!isValidWalletAddress(address)) return false;
  const updated = await db
    .update(copyWallets)
    .set({ active })
    .where(eq(copyWallets.address, address))
    .returning({ address: copyWallets.address });
  return updated.length > 0;
}

export type RemoveWalletResult = "ENTFERNT" | "NICHT_GEFUNDEN" | "HAT_TRADES";

/**
 * Entfernt eine Wallet — aber nur, wenn von ihr noch nie kopiert wurde.
 *
 * Sonst `HAT_TRADES`: die Zuordnung „dieser Trade kam von dieser Wallet" ist
 * das Einzige, was die spaetere Auswertung ueberhaupt moeglich macht. Sie
 * wegzuwerfen, um eine Zeile aus einer Liste zu bekommen, waere ein schlechter
 * Tausch. Zum Aufhoeren gibt es `active = false`.
 */
export async function removeCopyWallet(
  db: Database,
  address: string,
): Promise<RemoveWalletResult> {
  if (!isValidWalletAddress(address)) return "NICHT_GEFUNDEN";
  const deleted = await db
    .delete(copyWallets)
    .where(and(eq(copyWallets.address, address), eq(copyWallets.copiedCount, 0)))
    .returning({ address: copyWallets.address });
  if (deleted.length > 0) return "ENTFERNT";

  const [row] = await db
    .select({ copiedCount: copyWallets.copiedCount })
    .from(copyWallets)
    .where(eq(copyWallets.address, address))
    .limit(1);
  return row === undefined ? "NICHT_GEFUNDEN" : "HAT_TRADES";
}

/**
 * Setzt den Wasserstand des Kopierers.
 *
 * Nur vorwaerts: ein kleinerer Zeitstempel wuerde Trades doppelt kopieren.
 * Die Pruefung steht im SQL und nicht im Code, damit sie auch bei zwei
 * gleichzeitigen Laeufen haelt.
 */
export async function markCopyWalletChecked(
  db: Database,
  address: string,
  checkedAt: Date,
  lastSignature: string | null,
  copiedDelta: number,
): Promise<void> {
  if (!isValidWalletAddress(address)) return;
  if (!Number.isInteger(copiedDelta) || copiedDelta < 0) return;
  await db
    .update(copyWallets)
    .set({
      lastCheckedAt: checkedAt,
      ...(lastSignature === null ? {} : { lastSignature }),
      copiedCount: sql`${copyWallets.copiedCount} + ${copiedDelta}`,
    })
    .where(
      and(
        eq(copyWallets.address, address),
        sql`${copyWallets.lastCheckedAt} is null or ${copyWallets.lastCheckedAt} <= ${checkedAt.toISOString()}::timestamptz`,
      ),
    );
}
