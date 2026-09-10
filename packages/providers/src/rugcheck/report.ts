import { z } from "zod";

import { zodContract, type ResponseContract } from "../contract";

/**
 * RugCheck — `GET /v1/tokens/{mint}/report`.
 *
 * Gemessen am 2026-09-10 gegen zwei echte Antworten: USDC
 * (`EPjFWdd5…TDt1v`) und den Memecoin SIDE EYE BABY
 * (`7jAxKsGd…zapump`). HTTP 200, **ohne** API-Schluessel. Swagger hinterlegt
 * fuer die 200-Antwort kein Schema — die Antwort selbst ist die einzige
 * Quelle, und sie liegt vor.
 *
 * ### Der Befund, der die Anbieterwahl entschieden hat
 *
 * Roh gerechnet halten die zehn groessten KONTEN des Memecoins 95,70 %, das
 * groesste allein 41,92 %. Beides ist irrefuehrend:
 *
 * 1. Das groesste Konto gehoert dem Besitzer `7ZYnU2wr…`, und der steht in
 *    `knownAccounts` als **„Pump Fun AMM"** — der Liquiditaetspool. Er
 *    „haelt" nichts, er IST der Markt.
 * 2. Konto 2 und Konto 3 haben denselben Besitzer (`DZAvUwwv…`). Als zwei
 *    Halter gezaehlt sind das 17,5 % und 11,4 %; als ein Akteur sind es
 *    **28,9 %** — und erst das ist die Zahl, die etwas ueber Machtverteilung
 *    sagt.
 *
 * Nach Besitzern zusammengefasst und ohne Pool bleiben **55,7 %** statt
 * 95,7 %, und der groesste Akteur haelt **28,9 %** statt 41,9 %.
 *
 * Genau das kann der reine Kettenweg nicht (DECISIONS §112): dort gibt es
 * weder `owner` noch `knownAccounts`. Der Mehrwert dieses Anbieters ist nicht
 * die Prozentzahl — die steht auch in der Kette —, sondern die Zuordnung, die
 * sie erst richtig macht.
 *
 * ### Was `null` hier heisst
 *
 * Bei USDC sind `topHolders` und `markets` `null`, `totalHolders` ist `0`,
 * `risks` ist leer. Ein etablierter, unbedenklicher Token liefert also
 * NICHTS. `totalHolders: 0` heisst „nicht ermittelt" und niemals „keine
 * Halter"; `topHolders: null` heisst nicht „keine Konzentration".
 *
 * ### Eine Falle im Schema
 *
 * Es gibt `token.mintAuthority` (Adresse als Text oder `null`) UND ein
 * `mintAuthority` auf oberster Ebene — beim Memecoin `null`, bei USDC ein
 * ganzes Konto-Objekt mit `lamports`, `data` und `space`. Wer die obere
 * Ebene als Wahrheitswert liest, haelt USDC fuer sicher und den Memecoin fuer
 * gefaehrlich, also genau verkehrt herum. Dieses Schema liest ausschliesslich
 * `token.*`.
 */

export const RUGCHECK_REPORT_PATH = "/v1/tokens/{mint}/report";

/** Ein Konto aus der Halterliste. `amount` kommt als JSON-Zahl, nicht als Text. */
export const topHolderSchema = z
  .object({
    address: z.string(),
    /** Anteil an der Gesamtmenge in PROZENT: 41.92113558375941. */
    pct: z.number().finite().nonnegative(),
    /** Der BESITZER des Kontos. Der Schluessel, mit dem alles steht und faellt. */
    owner: z.string(),
    insider: z.boolean().optional(),
  })
  .passthrough();

/** `knownAccounts` ist nach BESITZER-Adresse verschluesselt, nicht nach Konto. */
export const knownAccountSchema = z
  .object({
    name: z.string(),
    /** Gemessen: "AMM", "LOCKER", "CREATOR". Offen fuer weitere. */
    type: z.string(),
  })
  .passthrough();

export const rugcheckReportSchema = z
  .object({
    mint: z.string(),
    /** Die Mint-Angaben. NICHT die gleichnamigen Felder der obersten Ebene. */
    token: z
      .object({
        supply: z.number().finite().nonnegative(),
        decimals: z.number().int().min(0).max(255),
        mintAuthority: z.string().nullable(),
        freezeAuthority: z.string().nullable(),
      })
      .passthrough(),
    topHolders: z.array(topHolderSchema).nullable(),
    knownAccounts: z.record(knownAccountSchema).default({}),
    markets: z
      .array(
        z
          .object({
            lp: z
              .object({ lpLockedPct: z.number().finite().nonnegative().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .nullable(),
    risks: z
      .array(
        z
          .object({ name: z.string(), level: z.string().optional(), score: z.number().optional() })
          .passthrough(),
      )
      .default([]),
    score: z.number().finite(),
    score_normalised: z.number().finite(),
    rugged: z.boolean(),
    totalHolders: z.number().int().nonnegative(),
    /** Der Ersteller und sein Bestand — Rohmenge, nicht Prozent. */
    creator: z.string().nullable().optional(),
    creatorBalance: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

export type RugcheckReport = z.infer<typeof rugcheckReportSchema>;

export const RUGCHECK_REPORT_CONTRACT: ResponseContract<RugcheckReport> = zodContract({
  schema: rugcheckReportSchema,
  schemaVersion: "rugcheck-report-v1@2026-09-10",
  verified: true,
});

/**
 * Kontotypen, die keinen HALTER darstellen.
 *
 * `AMM` ist der Liquiditaetspool: seine Bestaende gehoeren dem Markt, nicht
 * einem Akteur. `LOCKER` haelt gesperrte Liquiditaet und ebenso wenig.
 *
 * `CREATOR` steht bewusst NICHT hier. Der Ersteller ist ein Halter, und zwar
 * der risikoreichste — wer ihn herausrechnet, blendet genau den aus, dessen
 * Verkauf den Kurs zerlegt.
 */
export const NON_HOLDER_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["AMM", "LOCKER"]);

export interface HolderConcentration {
  /** Anteil der zehn groessten BESITZER, in Prozent. Pools ausgeschlossen. */
  readonly top10Pct: number;
  /** Anteil des groessten einzelnen Besitzers, in Prozent. */
  readonly topPct: number;
  /** Anteil des Erstellers, falls er in der Liste steht. */
  readonly creatorPct: number | null;
  /** Wie viele eigenstaendige Besitzer nach dem Zusammenfassen uebrig blieben. */
  readonly distinctOwners: number;
  /** Wie viele Konten als Pool oder Locker ausgeschlossen wurden. */
  readonly excludedAccounts: number;
}

/**
 * Konzentration nach BESITZERN, ohne Pools.
 *
 * Drei Schritte, und jeder einzelne aendert das Ergebnis erheblich:
 *
 * 1. Konten bekannter Pools und Locker fallen heraus — sie halten nichts.
 * 2. Konten desselben Besitzers werden addiert — zehn Wallets einer Hand sind
 *    ein Akteur, nicht zehn.
 * 3. Erst danach wird sortiert und werden die zehn groessten genommen.
 *
 * Sortiert wird hier und nicht beim Anbieter: die gemessene Antwort war
 * absteigend, die Dokumentation sichert das nirgends zu. „Die zehn groessten"
 * darf nicht von der Laune einer Antwort abhaengen — und nach dem Addieren
 * stimmt die Reihenfolge des Anbieters ohnehin nicht mehr.
 *
 * `null`, wenn es keine Liste gibt. Ausdruecklich nicht 0: bei USDC ist
 * `topHolders` `null`, und daraus „keine Konzentration" zu machen waere eine
 * Sicherheitsaussage, die niemand geprueft hat.
 */
export function holderConcentration(report: RugcheckReport): HolderConcentration | null {
  const holders = report.topHolders;
  if (holders === null || holders.length === 0) return null;

  const byOwner = new Map<string, number>();
  let excludedAccounts = 0;

  for (const holder of holders) {
    const known = report.knownAccounts[holder.owner];
    if (known !== undefined && NON_HOLDER_ACCOUNT_TYPES.has(known.type)) {
      excludedAccounts += 1;
      continue;
    }
    // Ausgeschrieben statt `(x ?? 0) + p`: `sae/no-numeric-fallback` kann
    // einen Summanden nicht von einem ersetzten Messwert unterscheiden.
    const bisher = byOwner.get(holder.owner);
    byOwner.set(holder.owner, bisher === undefined ? holder.pct : bisher + holder.pct);
  }

  if (byOwner.size === 0) return null;

  const sorted = [...byOwner.values()].sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10).reduce((sum, pct) => sum + pct, 0);
  const creator = report.creator;
  const creatorPct = creator === undefined || creator === null ? null : (byOwner.get(creator) ?? null);

  return {
    // Gekappt: gerundete Prozentangaben koennen sich zu mehr als 100
    // summieren, und ein Anteil ueber 100 % ist keine Aussage.
    top10Pct: Math.min(100, top10),
    topPct: Math.min(100, sorted[0] ?? 0),
    creatorPct: creatorPct === null ? null : Math.min(100, creatorPct),
    distinctOwners: byOwner.size,
    excludedAccounts,
  };
}

/** Der hoechste gemeldete LP-Sperranteil ueber alle Maerkte. `null` ohne Markt. */
export function lpLockedPct(report: RugcheckReport): number | null {
  const markets = report.markets;
  if (markets === null || markets.length === 0) return null;
  const values = markets
    .map((m) => m.lp?.lpLockedPct)
    .filter((v): v is number => typeof v === "number");
  return values.length === 0 ? null : Math.min(100, Math.max(...values));
}
