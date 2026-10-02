import type { Clock, DataProvenance, TokenId } from "@sae/core";
import { providerId, TEST_FIXTURE_PROVIDER_PREFIX } from "@sae/core";
import { loadEnv, providerEnvSchema, type KnownProviderId } from "@sae/config";
import {
  buildMarketDataChain,
  fetchMarketFromChain,
  snapshotSupportsEntry,
  type MarketDataAdapter,
  type MarketFields,
} from "@sae/pipeline";
import type { FeatureVector } from "@sae/scoring";
import type { PitReader, PitSnapshot } from "@sae/db";

import { buildFeatureVector } from "./feature-build";
import type { ProviderStatus } from "@sae/providers";

/**
 * Schritt 1 der Pipeline: woher kommen die Zahlen?
 *
 * Genau zwei Eingaenge, und sie sind bewusst nicht ineinander ueberfuehrbar:
 *
 *   LIVE          Die Anbieterkette wird aus der Konfiguration gebaut und
 *                 abgefragt. Antwortet niemand, ist das Ergebnis NO_SOURCE —
 *                 kein Ersatzwert, kein letzter bekannter Stand, nichts.
 *   TEST_FIXTURE  Ein ausdruecklich gekennzeichneter Eingabewert. Er geht
 *                 NICHT durch die Kette und ist kein Anbieter: er taucht in
 *                 keiner Provider-Health-Messung auf und faerbt keinen Status
 *                 auf CONNECTED. Sein einziger Zweck ist der Nachweis, dass die
 *                 Verarbeitung dahinter funktioniert.
 *
 * Die Trennung liegt im Typ, nicht in einer Konvention. Ein Fixture kann nicht
 * versehentlich als Live-Beobachtung durchgehen, weil er einen anderen Zweig
 * des Ergebnistyps traegt und eine Herkunft, die die Datenbank prueft.
 */

export interface LiveMarketRequest {
  readonly kind: "LIVE";
  readonly tokenId: TokenId;
  readonly mint: string;
  /** Geprüfte Adapter. Ohne Adapter kein Kettenmitglied. */
  readonly adapters: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
  readonly env: NodeJS.ProcessEnv;
  /** Fuer eine Einstiegsentscheidung `false`: DEGRADED reicht dafuer nicht. */
  readonly allowDegraded: boolean;
  /**
   * Die Historie, aus der der Feature-Vektor entsteht.
   *
   * Optional, weil nicht jeder Aufrufer entscheiden will — der reine
   * Marktdaten-Abruf braucht keine Features. Fehlt der Leser, bleibt
   * `features: null`, und der Durchlauf endet flussabwaerts ehrlich mit
   * `NO_FEATURE_VECTOR`.
   */
  readonly pit?: PitReader;
  /** Fuer `tokenAgeSeconds`. */
  readonly firstSeenAt?: Date | null;
}

/**
 * Ein Test-Fixture.
 *
 * Er traegt einen vollstaendigen Feature-Vektor und nicht nur Marktfelder.
 * Grund: aus reinen Marktdaten laesst sich die Gewichtsabdeckung der
 * Score-Engine nicht erreichen — der Live-Pfad wuerde dort ehrlich mit
 * DATA_INCOMPLETE abbrechen. Ein Fixture, der die Pipeline dahinter pruefen
 * soll, muss also weiter vorne einsteigen duerfen. Das ist zulaessig, WEIL er
 * als Fixture gekennzeichnet ist und nirgends als Messung zaehlt.
 */
export interface TestFixtureRequest {
  readonly kind: "TEST_FIXTURE";
  readonly tokenId: TokenId;
  /** Sprechendes Etikett, erscheint als `source_provider` in der Datenbank. */
  readonly label: string;
  readonly features: FeatureVector;
  /** Wann der Fixture eingespeist wurde. */
  readonly suppliedAt: Date;
}

export type MarketInputRequest = LiveMarketRequest | TestFixtureRequest;

export type MarketInputResult =
  | {
      readonly kind: "OK";
      readonly market: MarketFields | null;
      readonly provenance: Omit<DataProvenance, "decisionTimestamp">;
      /**
       * Das ECHTE Datenalter des Anbieters — `null`, wenn er keines liefert.
       *
       * Steht hier getrennt, weil `DataProvenance` es nicht traegt: dort gibt
       * es nur `sourceTimestamp` und `dataTimestamp`, und beide sind im
       * Live-Pfad UNSERE Uhr. Wer daraus die Differenz bildet, bekommt fuer
       * jeden Anbieter ohne Zeitstempel eine Null — also „taufrisch" fuer
       * genau die Daten, deren Alter niemand kennt.
       *
       * Der Wert kommt unveraendert aus `Sourced.freshnessSeconds` und wird
       * nirgends errechnet.
       */
      readonly freshnessSeconds: number | null;
      /** Nur beim Fixture gesetzt — der Live-Pfad baut die Features selbst. */
      readonly features: FeatureVector | null;
      /**
       * Wer VOR der liefernden Quelle gefragt wurde und nichts hergab.
       *
       * Leer, wenn die erste Quelle geantwortet hat. Steht etwas darin, ist
       * das ein Rueckfall — und bei Marktdaten ist ein Rueckfall keine
       * Nebensaechlichkeit: faellt die Kette vom Router auf die
       * Marktdatenquelle zurueck, fehlen anschliessend Preiseinfluss und
       * Ausstiegsfaehigkeit, und der Snapshot traegt keinen Zeitstempel. Die
       * Entscheidung endet dann drei Schritte spaeter mit
       * `DATA_QUALITY_TOO_LOW` — mit einem Grund, der nach einem Datenproblem
       * aussieht, obwohl die eigentliche Auskunft lautet: der Router hat
       * nicht geantwortet, und zwar deshalb.
       *
       * `resolveFromChain` fuehrt die Versuche laengst mit; sie wurden auf dem
       * Erfolgspfad nur weggeworfen.
       */
      readonly fallbackFrom: readonly string[];
    }
  /** Keine Quelle hat geantwortet. Regulaeres Ergebnis, kein Fehler. */
  | {
      readonly kind: "NO_SOURCE";
      readonly reason: string;
      readonly attempted: readonly string[];
    };

/**
 * Holt die Marktdaten — ueber die Kette, wenn LIVE.
 *
 * Hier steht der Aufruf, der bis zuletzt gefehlt hat: `fetchMarketFromChain`
 * und damit `resolveFromChain`. Vorher wurde die Kette gebaut und nur ihre
 * Laenge geprueft; das ist der Unterschied zwischen „konstruiert" und
 * „benutzt".
 */
export async function resolveMarketInput(
  request: MarketInputRequest,
  clock: Clock,
): Promise<MarketInputResult> {
  if (request.kind === "TEST_FIXTURE") {
    return {
      kind: "OK",
      market: null,
      features: request.features,
      // Ein Fixture fragt keine Kette. Kein Rueckfall, nicht „unbekannt".
      fallbackFrom: [],
      // Beim Fixture ist die Differenz eine echte Aussage: `asOf` ist ein
      // angegebener Datenzeitpunkt und nicht unsere Abrufzeit.
      freshnessSeconds:
        (request.suppliedAt.getTime() - request.features.asOf.getTime()) / 1_000,
      provenance: {
        sourceType: "TEST_FIXTURE",
        // Das Praefix ist nicht Kosmetik: eine CHECK-Constraint in der
        // Datenbank verlangt es. Ein Fixture ohne erkennbares Etikett kann
        // nicht gespeichert werden.
        sourceProvider: `${TEST_FIXTURE_PROVIDER_PREFIX}${request.label}`,
        sourceTier: null,
        sourceTimestamp: request.suppliedAt,
        dataTimestamp: request.features.asOf,
        dataQuality: 0,
      },
      };
  }

  const chain = buildMarketDataChain({
    env: loadEnv(providerEnvSchema, request.env),
    adapters: request.adapters,
    statusOf: request.statusOf,
  });

  if (chain.members.length === 0) {
    return { kind: "NO_SOURCE", reason: chain.note, attempted: [] };
  }

  const result = await fetchMarketFromChain({
    chain,
    mint: request.mint,
    clock,
    allowDegraded: request.allowDegraded,
  });

  if (result.kind === "NO_SOURCE") {
    return {
      kind: "NO_SOURCE",
      reason: result.reason,
      attempted: result.attempts.map((a) => `${String(a.providerId)}=${a.outcome}`),
    };
  }

  const asOf = clock.now();
  const frisch: PitSnapshot = {
    ...result.data.value, tokenId: request.tokenId, observedAt: result.data.observedAt,
    sourceProviderId: String(result.data.providerId), sourceTier: result.data.tier,
    sourceFreshnessSeconds: result.data.freshnessSeconds,
    finalScore: null, dataCompleteness: 0, scoreEngineVersion: null,
  };

  /**
   * Welcher Snapshot die Entscheidung tragen soll.
   *
   * Frischer ist besser, und deshalb gewinnt der gerade geholte — aber nur,
   * solange er eine Einstiegsentscheidung ueberhaupt tragen KANN. Konnte er
   * das nicht, wurde bis hierher trotzdem er genommen, und das hat 24 Stunden
   * lang jeden Einstieg verhindert:
   *
   * Der Auffrischungslauf holt sich alle 20 Sekunden einen vollstaendigen
   * Snapshot vom Router — mit Preiseinfluss und Ausstiegsfaehigkeit — und
   * schreibt ihn in die Datenbank. Die Entscheidung holte sich danach einen
   * EIGENEN Datensatz, fiel bei schweigendem Router auf die Marktdatenquelle
   * zurueck (die keine Route rechnet und keinen Zeitstempel liefert) und
   * tauschte damit einen vollstaendigen Snapshot gegen einen unvollstaendigen.
   * Anschliessend fehlten drei der dreizehn Pflichtfelder, `finalScore` wurde
   * `null`, und `null` wird VOR der Schwelle geprueft — eine Schwelle von 10
   * und eine von 95 fuehrten zum identischen `REJECT / DATA_INCOMPLETE`.
   *
   * Es werden ausdruecklich KEINE Felder aus zwei Snapshots gemischt; das
   * waere eine erfundene Reihe (siehe `feature-build.ts`). Es wird zwischen
   * zwei in sich geschlossenen Snapshots EINER gewaehlt, und seine Herkunft
   * wandert mit — sonst stuende in der Aufzeichnung die falsche Quelle.
   */
  const frischTraegt = snapshotSupportsEntry({
    providerId: result.data.providerId,
    tier: result.data.tier,
    freshnessSeconds: result.data.freshnessSeconds,
    contributors: [],
  }).allowed;

  const gespeichert =
    frischTraegt || request.pit === undefined
      ? null
      : await request.pit.snapshotAt(request.tokenId, asOf);
  const gespeichertTraegt =
    gespeichert !== null && gespeichert.sourceProviderId !== null && entryCapable(gespeichert, asOf);

  const gewaehlt = gespeichertTraegt && gespeichert !== null ? gespeichert : frisch;
  const getauscht = gewaehlt !== frisch;

  // Use the chosen acquisition for both the feature vector and entry quality gate.
  // Historical comparisons remain anchored to this provider and observation time.
  const features =
    request.pit === undefined
      ? null
      : await buildFeatureVector({
          pit: request.pit,
          currentSnapshot: gewaehlt,
          tokenId: request.tokenId,
          asOf,
          firstSeenAt: request.firstSeenAt ?? null,
        });

  return {
    kind: "OK",
    market: result.data.value,
    features,
    // Alles vor dem erfolgreichen Versuch. `OK` steht nur am letzten.
    fallbackFrom: [
      ...result.attempts
        .filter((a) => a.outcome !== "OK")
        .map((a) => `${String(a.providerId)}=${a.outcome}`),
      // Dass getauscht wurde, gehoert in die Aufzeichnung. Ein stiller Tausch
      // waere derselbe Fehler wie der stille Downgrade, nur in die andere
      // Richtung.
      ...(getauscht ? [`gespeichert=${String(gewaehlt.sourceProviderId)}`] : []),
    ],
    freshnessSeconds: gewaehlt.sourceFreshnessSeconds,
    // Die Herkunft des GEWAEHLTEN Snapshots, nicht die des Abrufs. Stuende
    // hier der Abruf, behauptete die Aufzeichnung eine Quelle, aus der die
    // Zahlen nicht stammen — und das Einstiegstor beurteilte die falsche.
    provenance: {
      sourceType: "LIVE",
      sourceProvider: String(gewaehlt.sourceProviderId),
      sourceTier: gewaehlt.sourceTier,
      sourceTimestamp: asOf,
      // ACHTUNG beim Lesen: `observedAt` ist UNSERE Kenntniszeit, nicht die
      // Messzeit des Anbieters. Die Differenz zu `sourceTimestamp` ist
      // deshalb keine Frische, sondern die Dauer des eigenen Abrufs.
      dataTimestamp: gewaehlt.observedAt,
      dataQuality: 0,
    },
  };
}

/**
 * Kann dieser GESPEICHERTE Snapshot eine Einstiegsentscheidung tragen?
 *
 * Dieselbe Frage wie `snapshotSupportsEntry`, aber fuer eine Zeile aus der
 * Datenbank — und mit einem Unterschied, der entscheidend ist: das Alter.
 *
 * `sourceFreshnessSeconds` ist das Alter beim ABRUF. Es als heutiges Alter zu
 * lesen hiesse, eine zehn Minuten alte Zeile fuer acht Sekunden frisch zu
 * halten — genau die Sorte Fehler, die dieses System an jeder anderen Stelle
 * vermeidet. Das ehrliche Alter ist die Summe aus beidem: wie lange die Zeile
 * bei uns liegt, plus wie alt sie beim Abruf schon war.
 *
 * `null` bleibt dabei unbekannt und nicht null: eine Quelle ohne Zeitstempel
 * traegt keinen Einstieg, und das gilt gespeichert genauso wie frisch.
 */
function entryCapable(snapshot: PitSnapshot, asOf: Date): boolean {
  // Ohne Stufe ist die Guete der Quelle unbekannt, und unbekannt traegt keinen
  // Einstieg — dieselbe Vorgabe wie ueberall sonst.
  if (snapshot.sourceTier === null) return false;
  if (snapshot.sourceFreshnessSeconds === null) return false;
  const liegezeit = (asOf.getTime() - snapshot.observedAt.getTime()) / 1_000;
  if (liegezeit < 0) return false;
  return snapshotSupportsEntry({
    providerId: providerId(String(snapshot.sourceProviderId)),
    tier: snapshot.sourceTier,
    freshnessSeconds: liegezeit + snapshot.sourceFreshnessSeconds,
    contributors: [],
  }).allowed;
}
