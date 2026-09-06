import {
  missing,
  mint as toMint,
  observed,
  providerId,
  type Clock,
  type Maybe,
  type MissingReason,
} from "@sae/core";
import type { DiscoveredToken, DiscoverySource } from "@sae/discovery";
import {
  DexScreenerMarketAdapter,
  DexScreenerProfilesAdapter,
  type DexScreenerMarket,
  type ProfilesFetchOutcome,
} from "@sae/providers";

/**
 * Die Quelle, die der Discovery bisher fehlte.
 *
 * Sieb, Deduplizierung, Bewertung und Entscheidung waren seit Langem gebaut
 * und getestet. Es kam nur nie etwas an: `DiscoveryRunInput.sources` blieb
 * leer, weil niemand das Interface implementiert hatte. Diese Datei schliesst
 * genau diese eine Luecke — alles dahinter bleibt unberuehrt.
 *
 * ### Zwei Aufrufe, und der zweite ist der wichtige
 *
 * 1. `/token-profiles/latest/v1` liefert **Adressen**. Keinen Preis, keine
 *    Liquiditaet, kein Volumen, kein Alter — nur Kette, Adresse und
 *    Marketingtext.
 * 2. `/tokens/v1/solana/{adressen}` liefert die Marktdaten dazu, in Buendeln.
 *
 * Der erste allein waere wertlos und gefaehrlich zugleich: ein Bot, der nur
 * Schritt 1 kennt, handelt Werbetexte. Der zweite Aufruf ist der bereits
 * geprueft Adapter — dieselbe Antwortform, dasselbe Schema, dieselbe
 * Validierung.
 *
 * ### Was hier NICHT entschieden wird
 *
 * Nichts. Diese Quelle sagt „diesen Token gibt es und er ist mir aufgefallen",
 * nicht „er ist gut". Die Trennung ist Absicht und der Grund, warum viele Bots
 * handeln, was gerade auf einer Liste steht: sie vermischen die beiden Rollen.
 *
 * Beobachtet wurde in der Stichprobe vom 2026-09-06 ein Token namens „Solana"
 * mit 2,1 Mrd. USD gemeldeter Liquiditaet und 17 USD Tagesumsatz. Solche
 * Eintraege kommen hier durch — und fallen im Vorsieb und in der Marktauswahl.
 */

/** Grobwerte fuer das billige Vorsieb, aus dem zweiten Aufruf. */
interface Coarse {
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly poolAddress: string | null;
  readonly symbol: string | null;
  readonly pairCreatedAt: Date | null;
}

export interface ProfileDiscoveryDeps {
  readonly clock: Clock;
  readonly baseUrl?: string;
  /** Wie viele Adressen ein Anreicherungsaufruf traegt. */
  readonly bulkLimit?: number;
}

const DEFAULT_BULK_LIMIT = 30;
const SOURCE_ID = providerId("dexscreener");

/**
 * Baut die Discovery-Quelle.
 *
 * `trigger: "NEW_LAUNCH"` ist die ehrliche Einordnung: der Profil-Strom meldet
 * Token, die neu eingereicht wurden. Das ist NICHT dasselbe wie ein neues
 * Handelspaar (`NEW_PAIR`) — ein Projekt kann sein Profil lange nach dem
 * Start einreichen. Die Unterscheidung stehenzulassen ist wichtiger, als sie
 * bequem zu machen: sie landet in der Aufzeichnung und beantwortet spaeter,
 * welcher Ausloeser tatsaechlich etwas taugt.
 */
export function dexScreenerProfileDiscovery(deps: ProfileDiscoveryDeps): DiscoverySource {
  const profiles = new DexScreenerProfilesAdapter({
    clock: deps.clock,
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
  });
  const markets = new DexScreenerMarketAdapter({
    clock: deps.clock,
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
  });

  return {
    id: SOURCE_ID,
    trigger: "NEW_LAUNCH",

    async discover(since: Date): Promise<Maybe<readonly DiscoveredToken[]>> {
      const now = deps.clock.now();

      const listed = await profiles.fetchProfiles();
      if (listed.kind !== "OK") {
        // Ein Ausfall ist kein leeres Ergebnis. `Missing` mit Grund, damit die
        // Discovery-Engine ihn als ausgefallene Quelle benennen kann statt die
        // Abdeckung stillschweigend fuer vollstaendig zu halten.
        // Die Gruende sind die des Kerns, nicht erfundene: eine unlesbare
        // Antwort ist PARSE_FAILED, ein Timeout PROVIDER_TIMEOUT, eine
        // Drosselung PROVIDER_RATE_LIMITED. Sie landen in der Aufzeichnung und
        // beantworten spaeter, warum die Abdeckung an einem Tag duenn war.
        return missing(reasonOf(listed), now, SOURCE_ID);
      }

      // `since` wird bewusst NICHT als Filter benutzt: der Strom traegt keinen
      // Zeitstempel je Eintrag. Ihn nach `since` zu filtern hiesse, eine
      // Zeitangabe zu erfinden, die es nicht gibt. Die Deduplizierung der
      // Engine erledigt, was `since` erledigen sollte — sie kennt bereits
      // gesehene Adressen.
      void since;

      const coarse = await enrich(
        markets,
        listed.profiles.map((p) => p.mint),
        deps.bulkLimit ?? DEFAULT_BULK_LIMIT,
      );

      const tokens: DiscoveredToken[] = listed.profiles.map((p): DiscoveredToken => {
        const c = coarse.get(p.mint);
        return {
          mint: toMint(p.mint),
          trigger: "NEW_LAUNCH",
          source: SOURCE_ID,
          // Wann WIR ihn gesehen haben. Der Anbieter liefert keinen eigenen
          // Zeitpunkt — hier einen zu erfinden waere Look-Ahead.
          observedAt: now,
          launchedAt: c?.pairCreatedAt ?? null,
          symbol: c?.symbol ?? null,
          poolAddress: c?.poolAddress ?? null,
          liquidityUsd:
            c?.liquidityUsd === undefined || c.liquidityUsd === null
              ? missing("NOT_SUPPORTED_BY_PROVIDER", now, SOURCE_ID)
              : observed(c.liquidityUsd, SOURCE_ID, now),
          marketCapUsd:
            c?.marketCapUsd === undefined || c.marketCapUsd === null
              ? missing("NOT_SUPPORTED_BY_PROVIDER", now, SOURCE_ID)
              : observed(c.marketCapUsd, SOURCE_ID, now),
        };
      });

      return observed(tokens, SOURCE_ID, now);
    },
  };
}

/**
 * Holt die Grobwerte in Buendeln.
 *
 * Einzeln waeren es so viele Aufrufe wie Token; in Buendeln zu 30 sind es ein
 * Bruchteil. Faellt ein Buendel aus, fehlen nur dessen Grobwerte — die
 * betroffenen Token kommen ohne durch und fallen im Vorsieb als
 * `DATA_INCOMPLETE`. Das ist besser, als den ganzen Durchlauf zu verwerfen.
 *
 * Bei mehreren Pools je Token gewinnt der mit der hoechsten gemeldeten
 * Liquiditaet — dieselbe Regel wie in `selectMarket`, hier nur als Grobwert
 * fuer das billige Vorsieb. Die verbindliche Auswahl trifft spaeter
 * `selectMarket` mit allen Ausschlussgruenden.
 */
async function enrich(
  adapter: DexScreenerMarketAdapter,
  mints: readonly string[],
  bulkLimit: number,
): Promise<ReadonlyMap<string, Coarse>> {
  const out = new Map<string, Coarse>();

  for (const batch of DexScreenerMarketAdapter.batches(mints, bulkLimit)) {
    const result = await adapter.fetchMarkets(batch);
    if (result.kind !== "OK") continue;

    for (const m of result.markets) {
      const previous = out.get(m.baseMint);
      if (previous === undefined || beatsPrevious(previous.liquidityUsd, m.liquidityUsd)) {
        out.set(m.baseMint, toCoarse(m));
      }
    }
  }

  return out;
}

/**
 * Loest der neue Pool den bisherigen ab?
 *
 * Ausdruecklich ohne `?? 0`: eine unbekannte Liquiditaet ist nicht null. Der
 * erste Entwurf hier verglich `(a ?? 0) >= (b ?? 0)` — damit haette ein Pool
 * mit unbekannter Liquiditaet gegen jeden bekannten verloren, als waere sein
 * Wert 0. Die Lint-Regel `sae/no-numeric-fallback` hat es abgefangen, und sie
 * hatte recht: das ist derselbe Fehler wie ueberall sonst, nur an einer
 * unscheinbaren Stelle.
 *
 * Die Regel hier lautet: ein bekannter Wert schlaegt einen unbekannten, unter
 * bekannten gewinnt der groessere, unter unbekannten bleibt der erste.
 */
function beatsPrevious(previous: number | null, candidate: number | null): boolean {
  if (candidate === null) return false;
  if (previous === null) return true;
  return candidate > previous;
}

/** Der Ausfallgrund in der Sprache des Kerns. */
function reasonOf(outcome: Exclude<ProfilesFetchOutcome, { kind: "OK" }>): MissingReason {
  if (outcome.kind === "SCHEMA_REJECTED") return "PARSE_FAILED";
  switch (outcome.failure) {
    case "RATE_LIMITED":
      return "PROVIDER_RATE_LIMITED";
    case "BLOCKED":
    case "UNAVAILABLE":
    case "BAD_REQUEST":
    case "UNKNOWN":
      return "PROVIDER_DOWN";
  }
}

function toCoarse(m: DexScreenerMarket): Coarse {
  return {
    liquidityUsd: m.liquidityUsd,
    marketCapUsd: m.marketCapUsd,
    poolAddress: m.pairAddress,
    symbol: m.baseSymbol,
    pairCreatedAt: m.pairCreatedAt,
  };
}
