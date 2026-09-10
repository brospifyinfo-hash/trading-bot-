import { isPresent, missing, type Clock, type Mint } from "@sae/core";
import {
  DEFAULT_STRATEGY_PARAMETERS,
  loadEnv,
  providerEnvSchema,
  readProviderConfig,
  type KnownProviderId,
  type StrategyParameters,
} from "@sae/config";
import {
  TokenSeenStore,
  UNRECORDED_DISCOVERY_SOURCE,
  applyDiscoveryOutcomes,
  isTokenBlacklisted,
  recordAuthorities,
  type AuthorityRecord,
  type Database,
  type DiscoveryOutcome,
} from "@sae/db";
import {
  runDiscovery,
  type DiscoverySource,
  type TokenAuthorities,
} from "@sae/discovery";
import { tally, type Logger } from "@sae/observability";
import { SOLANA_MINT_CONTRACT, statusAllowsUse, type ProviderStatus } from "@sae/providers";

import { dexScreenerProfileDiscovery } from "./discovery-source";

/**
 * Der Lauf, der den Bot Tokens finden laesst.
 *
 * Bis hierher war die Kette an einer Stelle unterbrochen, und zwar an einer
 * unauffaelligen: Quelle, Sieb, Deduplizierung und Zustandspflege existierten
 * einzeln und getestet — nur rief sie niemand zusammen auf. Der Auftrag
 * `DISCOVER_TOKENS` lief in denselben Handler wie jede andere Marktdatenarbeit,
 * fand keinen Mint im Auftrag und meldete `NO_SOURCE`. Das war korrekt und
 * nutzlos zugleich.
 *
 * ### Was hier entschieden wird — und was nicht
 *
 * Entschieden wird nur, ob ein Token die teure Anreicherung wert ist. Nicht
 * entschieden wird, ob er gut ist, ob er gehandelt wird oder was er wert ist.
 * Diese Trennung ist der Grund, warum das Vorsieb ausdruecklich grob bleibt:
 * wer hier fein filtert, verliert Kandidaten, bevor die eigentliche Analyse
 * sie je gesehen hat, und merkt es nie.
 *
 * ### Die Luecke, die dieser Lauf offenlegt
 *
 * `cheapScreen` prueft Mint- und Freeze-Authority. Beide Werte kommen aus dem
 * Mint-Account on-chain, und dafuer gibt es bisher kein geprueftes Lesemodul.
 * Sie sind deshalb UNBEKANNT — und `cheapScreen` lehnt bei Unbekanntem NICHT
 * ab (`isPresent(...) && ...value`). Das ist im Vorsieb vertretbar und wird
 * hier trotzdem gezaehlt und geloggt, weil es eine echte Abschwaechung ist:
 * ein Token mit aktiver Mint-Authority kommt durch das Sieb.
 *
 * Was ihn NICHT durchlaesst, ist die Einstiegsentscheidung. `securityScore`
 * gibt ohne Mint-Authority, Freeze-Authority und Top-10-Anteil
 * `notComputable` zurueck, die Datenvollstaendigkeit faellt unter
 * `minDataCompleteness`, und das harte Gate lehnt mit `DATA_INCOMPLETE` ab.
 * Die Sicherheit haengt also nicht am Vorsieb — aber die Zahl im Log gehoert
 * gesehen, solange sie ungleich null ist.
 */

/**
 * Wie weit der Lauf zurueckblickt.
 *
 * Der heutige Profil-Strom ignoriert `since`: er traegt keinen Zeitstempel je
 * Eintrag, und einen zu erfinden waere Look-Ahead. Der Wert wird trotzdem
 * ehrlich gefuellt, weil eine spaetere Quelle mit echten Zeitstempeln ihn
 * braucht — und weil ein fest verdrahtetes `new Date(0)` beim ersten Einsatz
 * einer solchen Quelle den gesamten Verlauf anfordern wuerde.
 */
const LOOKBACK_MS = 10 * 60_000;

export interface DiscoveryRunDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly env: NodeJS.ProcessEnv;
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
  readonly parameters?: StrategyParameters;
  /** Quellen. Ohne Angabe die aus der Konfiguration ableitbaren. */
  readonly sources?: readonly DiscoverySource[];
  /**
   * Die Autoritaetspruefung.
   *
   * Die Naht, an der spaeter das Lesemodul fuer den Mint-Account haengt. Ohne
   * sie bleiben beide Werte unbekannt — siehe die Anmerkung oben. Sie ist hier
   * ausgewiesen und nicht versteckt, damit sichtbar bleibt, dass genau ein
   * Baustein fehlt und nicht die halbe Sicherheitspruefung.
   */
  readonly checkAuthorities?: (mint: Mint) => Promise<TokenAuthorities>;
}

export interface DiscoveryRunSummary {
  readonly status: "OK" | "NO_SOURCE";
  /** Meldungen aller Quellen, inklusive Mehrfachmeldungen. */
  readonly seen: number;
  /** Davon neu — der Rest war bereits bekannt. */
  readonly fresh: number;
  /** Durch das Vorsieb, damit bereit fuer die Anreicherung. */
  readonly candidates: number;
  /** Vorerst gescheitert, bleibt aber in Beobachtung. */
  readonly watchlist: number;
  /** Endgueltig verworfen. */
  readonly rejected: number;
  readonly duplicates: number;
  readonly failedSources: readonly string[];
  /** Tokens, die das Vorsieb ohne Autoritaetspruefung passiert haben. */
  readonly withoutAuthorityCheck: number;
  /**
   * Wie viele Sicherheitszeilen der Lauf geschrieben hat.
   *
   * Meist 0 — Autoritaeten aendern sich selten, und eine Zeile entsteht nur
   * bei Aenderung. Eine Zahl groesser 0 heisst deshalb entweder „neuer Token"
   * oder „an einem bekannten Token hat sich etwas geaendert", und das Zweite
   * ist ein Ereignis: wer eine Mint-Autoritaet wieder aktiviert, hat gerade
   * die Voraussetzung fuer beliebiges Nachpraegen geschaffen.
   */
  readonly authoritiesWritten: number;
  readonly reasons: Readonly<Record<string, number>>;
}

const EMPTY_SUMMARY: DiscoveryRunSummary = {
  status: "NO_SOURCE",
  seen: 0,
  fresh: 0,
  candidates: 0,
  watchlist: 0,
  rejected: 0,
  duplicates: 0,
  failedSources: [],
  withoutAuthorityCheck: 0,
  authoritiesWritten: 0,
  reasons: {},
};

/**
 * Welche Quellen ueberhaupt gefragt werden.
 *
 * Drei Bedingungen, alle drei notwendig: der Anbieter ist konfiguriert, er
 * traegt die Faehigkeit `TOKEN_DISCOVERY`, und seine letzte MESSUNG erlaubt
 * eine Nutzung. Die dritte ist die wichtigste — sie stammt aus dem
 * provider-health-Dienst und nicht aus dem Speicher dieses Prozesses. Einen
 * Anbieter zu fragen, der nachweislich nicht antwortet, erzeugt nur Fehler,
 * die wie Datenprobleme aussehen.
 */
export function buildDiscoverySources(deps: {
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
}): readonly DiscoverySource[] {
  const providerEnv = loadEnv(providerEnvSchema, deps.env);
  const sources: DiscoverySource[] = [];

  for (const entry of readProviderConfig(providerEnv)) {
    if (!entry.configured) continue;
    if (!entry.capabilities.includes("TOKEN_DISCOVERY")) continue;
    if (!statusAllowsUse(deps.statusOf(entry.id))) continue;

    // Nur Anbieter mit einem gegen eine echte Antwort geprueften Adapter. Die
    // Liste waechst mit jedem Vertrag, den jemand belegt hat — nicht mit jedem
    // Anbieter, der Discovery bewirbt.
    if (entry.id === "dexscreener") {
      sources.push(
        dexScreenerProfileDiscovery({
          clock: deps.clock,
          ...(providerEnv.DEXSCREENER_BASE_URL !== undefined
            ? { baseUrl: providerEnv.DEXSCREENER_BASE_URL }
            : {}),
        }),
      );
    }
  }

  return sources;
}

/**
 * Haelt fest, welche Quelle welchen Mint gemeldet hat.
 *
 * Die Deduplizierung schreibt die Zeile, aber sie reicht die Herkunft nicht
 * durch — ihre Schnittstelle kennt nur `(mint, at)`. Statt die Schnittstelle
 * zu erweitern (sie ist an drei Stellen implementiert) merkt sich dieser
 * Aufsatz beim Einsammeln, woher jeder Mint kam. Mit einer Quelle waere auch
 * eine Konstante richtig; mit zweien waere sie es nicht mehr, und der Fehler
 * fiele niemandem auf, weil `discovery_source` nirgends weh tut.
 */
function recordingSources(
  sources: readonly DiscoverySource[],
  into: Map<string, string>,
): readonly DiscoverySource[] {
  return sources.map(
    (source): DiscoverySource => ({
      id: source.id,
      trigger: source.trigger,
      async discover(since: Date) {
        const result = await source.discover(since);
        if (isPresent(result)) {
          for (const token of result.value) {
            if (!into.has(token.mint)) into.set(token.mint, String(token.source));
          }
        }
        return result;
      },
    }),
  );
}

export async function runTokenDiscovery(deps: DiscoveryRunDeps): Promise<DiscoveryRunSummary> {
  const now = deps.clock.now();
  const sources =
    deps.sources ??
    buildDiscoverySources({ env: deps.env, clock: deps.clock, statusOf: deps.statusOf });

  if (sources.length === 0) {
    // Kein regulaerer Fehler: ohne erreichbare Quelle gibt es nichts zu finden.
    // Ein Fehlschlag wuerde den Auftrag ins Dead Letter tragen und dort jede
    // halbe Minute eine Zeile hinterlassen, obwohl das System nur wartet.
    deps.logger.debug({ role: "discovery" }, "Keine nutzbare Discovery-Quelle");
    return EMPTY_SUMMARY;
  }

  const origin = new Map<string, string>();
  const store = new TokenSeenStore(
    deps.db,
    (mint) => origin.get(mint) ?? UNRECORDED_DISCOVERY_SOURCE,
  );

  // Ohne Lesemodul fuer den Mint-Account bleiben beide Autoritaeten UNBEKANNT.
  // `NOT_YET_COLLECTED` und ausdruecklich nicht `NOT_SUPPORTED_BY_PROVIDER`:
  // die Angabe steht on-chain und ist abrufbar — sie wurde nur noch nicht
  // abgerufen. Der Unterschied entscheidet spaeter, ob jemand nach einem
  // anderen Anbieter sucht oder das fehlende Modul baut.
  const unknownAuthorities: TokenAuthorities = {
    mintAuthorityActive: missing("NOT_YET_COLLECTED", now, null),
    freezeAuthorityActive: missing("NOT_YET_COLLECTED", now, null),
  };
  const read = deps.checkAuthorities;

  // Gezaehlt wird das ERGEBNIS, nicht der Weg dorthin: auch ein vorhandenes
  // Lesemodul kann fuer einen einzelnen Mint nichts liefern, und dann ist die
  // Luecke dieselbe.
  let withoutAuthorityCheck = 0;
  // Was gelesen wurde, wird auch behalten. Vorher diente das Ergebnis nur dem
  // Vorsieb und war danach weg — obwohl es zwei Felder des Sicherheitsteils
  // im Feature-Vektor fuellt und laengst bezahlt war (DECISIONS §111).
  const gelesen: AuthorityRecord[] = [];
  const checkAuthorities = async (mint: Mint): Promise<TokenAuthorities> => {
    const authorities = read === undefined ? unknownAuthorities : await read(mint);
    if (
      isPresent(authorities.mintAuthorityActive) &&
      isPresent(authorities.freezeAuthorityActive)
    ) {
      gelesen.push({
        mint,
        mintAuthorityActive: authorities.mintAuthorityActive.value,
        freezeAuthorityActive: authorities.freezeAuthorityActive.value,
      });
    } else {
      withoutAuthorityCheck += 1;
    }
    return authorities;
  };

  const result = await runDiscovery({
    sources: recordingSources(sources, origin),
    since: new Date(now.getTime() - LOOKBACK_MS),
    store,
    clock: deps.clock,
    parameters: deps.parameters ?? DEFAULT_STRATEGY_PARAMETERS,
    isBlacklisted: (mint: Mint) => isTokenBlacklisted(deps.db, mint),
    checkAuthorities,
  });

  const sourceOf = (mint: string): string => origin.get(mint) ?? UNRECORDED_DISCOVERY_SOURCE;
  const outcomes = new Map<string, DiscoveryOutcome>();

  for (const token of result.candidates) {
    outcomes.set(token.mint, {
      mint: token.mint,
      state: "SCREENING",
      symbol: token.symbol,
      launchedAt: token.launchedAt,
      discoverySource: sourceOf(token.mint),
    });
  }
  for (const token of result.watchlist) {
    outcomes.set(token.mint, {
      mint: token.mint,
      state: "WATCHLIST",
      symbol: token.symbol,
      launchedAt: token.launchedAt,
      discoverySource: sourceOf(token.mint),
    });
  }

  // Was dieser Lauf angelegt hat und in keiner der beiden Listen steht, ist
  // endgueltig ausgeschieden — `cheapScreen` fuehrt es weder als Kandidat noch
  // als beobachtet. Ohne diesen Abgleich bliebe die Zeile auf `DISCOVERED`
  // stehen und saehe aus wie ein Token, den noch niemand geprueft hat.
  for (const mint of store.added) {
    if (outcomes.has(mint)) continue;
    outcomes.set(mint, {
      mint,
      state: "REJECTED",
      symbol: null,
      launchedAt: null,
      discoverySource: sourceOf(mint),
    });
  }

  await applyDiscoveryOutcomes({ db: deps.db, outcomes: [...outcomes.values()] });

  // Erst NACH den Zustaenden: `token_security` haengt am Token-Datensatz, und
  // den gibt es fuer einen frisch entdeckten Mint vorher nicht.
  const authoritiesWritten = await recordAuthorities(
    deps.db,
    gelesen,
    SOLANA_MINT_CONTRACT.schemaVersion,
    now,
  );

  const reasons: Record<string, number> = {};
  for (const [reason, count] of result.rejected) reasons[reason] = count;

  const rejected = [...outcomes.values()].filter((o) => o.state === "REJECTED").length;
  const summary: DiscoveryRunSummary = {
    status: "OK",
    seen: result.totalSeen,
    fresh: store.added.length,
    candidates: result.candidates.length,
    watchlist: result.watchlist.length,
    rejected,
    duplicates: result.duplicatesSkipped,
    failedSources: result.failedSources,
    withoutAuthorityCheck,
    authoritiesWritten,
    reasons,
  };

  deps.logger.info(
    {
      role: "discovery",
      seen: summary.seen,
      fresh: summary.fresh,
      candidates: summary.candidates,
      watchlist: summary.watchlist,
      rejected: summary.rejected,
      duplicates: summary.duplicates,
      failedSources: summary.failedSources,
      // Als ein Wert, nicht als Objekt: die Allowlist prueft jeden
      // Schluessel, und Ablehnungsgruende sind Daten, keine Feldnamen.
      reasons: tally(summary.reasons),
    },
    "Discovery-Lauf abgeschlossen",
  );

  if (withoutAuthorityCheck > 0) {
    // Einmal je Lauf, nicht je Token: die Aussage ist „dem Vorsieb fehlt ein
    // Kriterium", nicht „dieser Token ist verdaechtig".
    deps.logger.warn(
      { role: "discovery", withoutAuthorityCheck },
      "Vorsieb ohne Autoritaetspruefung — Mint-/Freeze-Authority unbekannt, Einstieg bleibt durch DATA_INCOMPLETE gesperrt",
    );
  }

  return summary;
}
