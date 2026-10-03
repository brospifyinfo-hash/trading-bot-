import { sql } from "drizzle-orm";

import type { Database } from "../client";

/**
 * Warum ein Coin NICHT im Suchraum ist.
 *
 * Der Suchraum entscheidet, welche Coins ueberhaupt bewertet werden. Bis
 * hierher sagte darueber genau eine Zahl etwas: `beobachtet`. Steht die auf
 * 0, ist das bei den Filtern aus §149 eine wahrscheinliche Lage — und ohne
 * Begruendung sieht sie genauso aus wie ein kaputter Bot. Dasselbe Muster wie
 * §140, §144 und §145, und es soll sich nicht zum vierten Mal wiederholen.
 *
 * Besonders der Altersfilter ist ein Kandidat fuer eine stille Leere:
 * `tokens.launched_at` wird nur beim Uebergang aus dem Zustand `DISCOVERED`
 * geschrieben und nur, wenn die Anreicherung die Pool-Entstehungszeit
 * mitgeliefert hat. Fehlt sie, bleibt sie dauerhaft `null`, und bei gesetzter
 * Altersgrenze faellt der Coin fuer immer heraus. Ob das viele oder wenige
 * betrifft, sagt genau diese Auszaehlung.
 *
 * Die Gruende sind nach PRIORITAET geordnet, und zwar derselben wie im
 * Filter: der erste zutreffende gewinnt. Sonst stuende bei einem Coin, der
 * gleichzeitig zu gross und zu alt ist, der Zufall der Spaltenreihenfolge.
 */
export type UniverseExclusion =
  | "OK"
  | "GESPERRT"
  | "KEINE_AKTUELLEN_DATEN"
  | "KEIN_PREIS"
  | "ZU_WENIG_LIQUIDITAET"
  | "KEIN_VOLUMEN"
  | "KEINE_MARKTKAPITALISIERUNG"
  | "ZU_GROSS"
  | "ALTER_UNBEKANNT"
  | "ZU_ALT";

/**
 * Zaehlt die bekannten Coins nach ihrem Grund.
 *
 * Bewusst ueber ALLE Tokens und nicht nur ueber die Kandidaten: die Frage ist
 * „wo bleiben die 500, die wir kennen", und die beantwortet nur eine
 * Auszaehlung, die sie alle enthaelt.
 */
export async function countUniverseExclusions(
  db: Database,
  now: Date,
  limits: { maxMarketCapUsd?: bigint; maxCoinAgeMinutes?: number | null } = {},
): Promise<Readonly<Record<string, number>>> {
  const maxCap = limits.maxMarketCapUsd === undefined ? 5_000_000n : limits.maxMarketCapUsd;
  const maxAlter = limits.maxCoinAgeMinutes ?? null;
  const juengerAls = maxAlter === null
    ? null
    : new Date(now.getTime() - maxAlter * 60_000).toISOString();

  const rows = await db.execute<{ grund: string; anzahl: number }>(sql`
    select grund, count(*)::int as anzahl from (
      select case
        when t.blacklisted_at is not null or t.state = 'REJECTED' then 'GESPERRT'
        when latest.observed_at is null
          or latest.observed_at < ${new Date(now.getTime() - 6 * 3600000).toISOString()}::timestamptz
          then 'KEINE_AKTUELLEN_DATEN'
        when latest.price_usd is null or latest.price_usd <= 0 then 'KEIN_PREIS'
        when latest.liquidity_usd is null or latest.liquidity_usd < 5000 then 'ZU_WENIG_LIQUIDITAET'
        when latest.volume_24h_usd is null or latest.volume_24h_usd <= 0 then 'KEIN_VOLUMEN'
        when latest.market_cap_usd is null or latest.market_cap_usd <= 0
          then 'KEINE_MARKTKAPITALISIERUNG'
        when latest.market_cap_usd > ${Number(maxCap)} then 'ZU_GROSS'
        when ${juengerAls}::timestamptz is not null and t.launched_at is null
          then 'ALTER_UNBEKANNT'
        when ${juengerAls}::timestamptz is not null and t.launched_at < ${juengerAls}::timestamptz
          then 'ZU_ALT'
        else 'OK'
      end as grund
      from tokens t
      left join lateral (
        select s.liquidity_usd, s.market_cap_usd, s.volume_24h_usd, s.price_usd, s.observed_at
        from token_snapshots s
        where s.token_id = t.id and s.source_provider_id in ('jupiter-quote', 'dexscreener')
          and s.observed_at <= ${now.toISOString()}::timestamptz
        order by s.observed_at desc, s.id desc limit 1
      ) latest on true
    ) g
    group by grund
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const out: Record<string, number> = {};
  for (const row of list as { grund: string; anzahl: number }[]) {
    // Nur die bekannten Etiketten. Der Wert kommt aus einem CASE in eigenem
    // SQL, aber die Pruefung kostet nichts und haelt die Anzeige geschlossen.
    if (/^[A-Z_]{1,40}$/.test(row.grund) && Number.isSafeInteger(row.anzahl)) {
      out[row.grund] = row.anzahl;
    }
  }
  return out;
}
