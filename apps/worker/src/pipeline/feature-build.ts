import { missing, observed, providerId, type Maybe, type TokenId } from "@sae/core";
import type { PitReader, PitSecurity, PitSnapshot } from "@sae/db";
import type { FeatureVector } from "@sae/scoring";

/**
 * Der Feature-Vektor aus der Historie.
 *
 * Die Luecke, die diese Datei schliesst, stand als Literal im Code:
 * `resolveMarketInput` gab auf dem Live-Pfad `features: null` zurueck, und
 * `runOpportunityPipeline` brach daraufhin mit `NO_FEATURE_VECTOR` ab. Der
 * Kommentar daneben sagte, der Vektor entstehe „aus der Historie ueber den
 * PitReader" — nur tat das niemand. Dieselbe Klasse Luecke wie §87, §99 und
 * §109, zum vierten Mal.
 *
 * ### Warum ausschliesslich aus dem PitReader
 *
 * Es waere naheliegend, den gerade frisch abgerufenen Preis einzusetzen — er
 * ist juenger als der letzte Snapshot. Genau das waere aber falsch: eine
 * Preisaenderung ueber fuenf Minuten vergleicht zwei Messungen, und wenn die
 * eine vom Router und die andere aus der Snapshot-Historie stammt, misst die
 * Differenz auch den Unterschied zwischen den Anbietern. Eine Reihe muss aus
 * einer Reihe kommen.
 *
 * Der PitReader ist ausserdem die Vorkehrung gegen Look-Ahead: jede seiner
 * Methoden verlangt `asOf`, es gibt keine, die „den aktuellen Stand" liefert.
 * Ein Feature-Bauer ohne eigenen Datenbankzugriff kann deshalb gar nicht
 * versehentlich in die Zukunft schauen.
 *
 * ### Was fehlt, bleibt `Missing` — mit Grund
 *
 * Jedes Feld ist ein `Maybe`. Kein fehlender Wert wird zu einer Zahl, und kein
 * Ersatz wird gerechnet. Wo eine Naeherung moeglich waere, sie aber etwas
 * anderes messen wuerde als das Feld verspricht, steht `Missing` — siehe
 * `volumeAcceleration` unten. Ein plausibel aussehender Ersatzwert ist die
 * teuerste Sorte Fehler, weil ihn niemand mehr findet.
 */

/** Fenster der kurzfristigen Momentum-Messung. */
const WINDOW_5M_MS = 5 * 60 * 1_000;
/** Fenster der laengeren Messung. */
const WINDOW_1H_MS = 60 * 60 * 1_000;

/**
 * Toleranz bei der Suche nach dem Vergleichspunkt.
 *
 * Der Takt liegt bei 20 Sekunden, aber ein Snapshot kann ausfallen. Ohne
 * Toleranz waere die Messung dann still nicht vorhanden; mit zu grosser
 * Toleranz waere „vor 5 Minuten" in Wahrheit „vor 20 Minuten" und die
 * Prozentzahl gehoerte zu einem anderen Zeitraum als ihr Name sagt.
 */
const WINDOW_TOLERANCE_MS = 90 * 1_000;

/**
 * Wie weit zurueck die Historie geladen wird.
 *
 * Bewusst MEHR als das laengste Fenster, und der Test hat gezeigt, warum:
 * `snapshotsBetween` ist halboffen (`from` exklusiv). Wurde genau bis
 * `asOf - 1h` geladen, fiel ein Snapshot, der exakt eine Stunde alt war, aus
 * dem Ergebnis — der Vergleichspunkt fuer `priceChange1h` lag also per
 * Definition ausserhalb der geladenen Reihe.
 *
 * Im Betrieb waere das nie aufgefallen: `Missing` ist ein regulaeres Ergebnis,
 * und ein dauerhaft fehlendes Stundenmomentum sieht aus wie zu wenig Historie.
 * Die Toleranz braucht Daten auf BEIDEN Seiten ihres Zielpunkts.
 */
const HISTORY_SPAN_MS = WINDOW_1H_MS + 2 * WINDOW_TOLERANCE_MS;

export interface FeatureBuildInput {
  readonly pit: PitReader;
  readonly tokenId: TokenId;
  /** Zeitpunkt, fuer den die Features gelten. Alle Eingaben sind `<= asOf`. */
  readonly asOf: Date;
  /** Fuer `tokenAgeSeconds`. `null`, wenn der Token keinen Erstkontakt traegt. */
  readonly firstSeenAt: Date | null;
}

/**
 * `null`, wenn es zu diesem Token ueberhaupt keinen Snapshot gibt.
 *
 * Ein Vektor aus lauter `Missing` waere kein Feature-Vektor, sondern eine
 * aufwendige Art, „keine Daten" zu sagen — und er wuerde flussabwaerts als
 * Datenqualitaetsproblem erscheinen statt als fehlende Historie.
 */
export async function buildFeatureVector(input: FeatureBuildInput): Promise<FeatureVector | null> {
  const latest = await input.pit.snapshotAt(input.tokenId, input.asOf);
  if (latest === null) return null;

  const [history, security] = await Promise.all([
    input.pit.snapshotsBetween(
      input.tokenId,
      new Date(input.asOf.getTime() - HISTORY_SPAN_MS),
      input.asOf,
    ),
    input.pit.securityAt(input.tokenId, input.asOf),
  ]);

  // Die Features gelten fuer den Zeitpunkt der juengsten Messung, nicht fuer
  // „jetzt". Der Unterschied ist das Alter der Daten, und es gehoert nicht
  // wegdefiniert.
  const asOf = latest.observedAt;
  const from = (s: PitSnapshot) => providerId(s.sourceProviderId ?? "unknown");

  /** Ein Wert aus einem Snapshot, mit dessen Quelle und dessen Zeitpunkt. */
  const of = <T>(s: PitSnapshot, value: T | null): Maybe<T> =>
    value === null ? missing("NO_DATA_FOR_TOKEN", s.observedAt, from(s)) : observed(value, from(s), s.observedAt);

  /** Etwas, das dieses System heute nirgends erhebt. */
  const notCollected = <T>(): Maybe<T> => missing("NOT_YET_COLLECTED", asOf, null);

  const fiveMinutesAgo = at(history, input.asOf.getTime() - WINDOW_5M_MS);
  const anHourAgo = at(history, input.asOf.getTime() - WINDOW_1H_MS);

  return {
    tokenId: input.tokenId,
    asOf,
    security: securityFeatures(security, asOf),
    market: {
      priceUsd: of(latest, latest.priceUsd),
      liquidityUsd: of(latest, latest.liquidityUsd),
      marketCapUsd: of(latest, latest.marketCapUsd),
      volume24hUsd: of(latest, latest.volume24hUsd),
      tokenAgeSeconds:
        input.firstSeenAt === null
          ? missing("NO_DATA_FOR_TOKEN", asOf, null)
          : // Aus UNSEREM Erstkontakt, nicht aus dem Alter des Pools. Der Token
            // ist aelter, wenn wir ihn spaet gefunden haben — die Zahl heisst
            // „seit wann beobachten wir ihn" und wird auch so benutzt.
            observed(
              Math.max(0, Math.round((asOf.getTime() - input.firstSeenAt.getTime()) / 1_000)),
              providerId("discovery"),
              asOf,
            ),
    },
    momentum: {
      priceChange5m: relativeChange(latest, fiveMinutesAgo, (s) => s.priceUsd, asOf),
      priceChange1h: relativeChange(latest, anHourAgo, (s) => s.priceUsd, asOf),
      // Bewusst NICHT genaehert. Das Feld verlangt „Volumen der letzten 5
      // Minuten im Verhaeltnis zum Durchschnitt". Aus zwei Staenden eines
      // rollenden 24-Stunden-Volumens laesst sich ein Zufluss schaetzen, aber
      // das ist eine andere Groesse — und sie saehe der richtigen zum
      // Verwechseln aehnlich.
      volumeAcceleration: notCollected(),
      // Die Spalten `buys_5m`/`sells_5m` gibt es in der Tabelle, geschrieben
      // werden sie nie: `MarketFields` fuehrt keine Transaktionszahlen mit.
      buys5m: notCollected(),
      sells5m: notCollected(),
    },
    holder: {
      holders: of(latest, latest.holders),
      holderGrowth: absoluteChange(latest, anHourAgo, (s) => s.holders, asOf),
      distinctActors: notCollected(),
      largestClusterSharePct: notCollected(),
    },
    execution: {
      expectedCostBps: notCollected(),
      exitCapacityRatio: notCollected(),
      priceImpactBps: notCollected(),
    },
    pending: {
      smartMoneyBuyers: notCollected(),
      smartMoneySellers: notCollected(),
      socialAuthenticity: notCollected(),
      socialMomentum: notCollected(),
      devScore: notCollected(),
      narrativeScore: notCollected(),
    },
  };
}

function securityFeatures(security: PitSecurity | null, asOf: Date): FeatureVector["security"] {
  if (security === null) {
    // Kein Sicherheitsbefund. Heute der Regelfall: `token_security` wird von
    // niemandem befuellt, weil die Anreicherung noch keine geprueften Anbieter
    // hat. `NOT_YET_COLLECTED` sagt genau das — und ausdruecklich nicht
    // „unbedenklich".
    const nc = <T>(): Maybe<T> => missing("NOT_YET_COLLECTED", asOf, null);
    return {
      mintAuthorityActive: nc(),
      freezeAuthorityActive: nc(),
      lpBurnedOrLocked: nc(),
      top10HolderSharePct: nc(),
      topHolderSharePct: nc(),
      riskLevel: nc(),
    };
  }

  const src = providerId("token_security");
  const at = security.observedAt;
  const of = <T>(value: T | null): Maybe<T> =>
    value === null ? missing("NO_DATA_FOR_TOKEN", at, src) : observed(value, src, at);

  return {
    mintAuthorityActive: of(security.mintAuthorityActive),
    freezeAuthorityActive: of(security.freezeAuthorityActive),
    lpBurnedOrLocked: of(security.lpBurnedOrLocked),
    top10HolderSharePct: of(security.top10HolderSharePct),
    // Der groesste EINZELNE Halter wird nicht erhoben — `top10` ist die Summe
    // der zehn groessten und beantwortet eine andere Frage.
    topHolderSharePct: missing("NOT_YET_COLLECTED", at, src),
    riskLevel: of(security.riskLevel),
  };
}

/**
 * Der Snapshot, der einem Zeitpunkt am naechsten liegt — innerhalb der Toleranz.
 *
 * `null`, wenn die Historie an dieser Stelle ein Loch hat. Den naechstbesten zu
 * nehmen hiesse, eine Fuenf-Minuten-Aenderung ueber eine halbe Stunde zu
 * rechnen und sie trotzdem so zu nennen.
 */
function at(history: readonly PitSnapshot[], targetMs: number): PitSnapshot | null {
  let best: PitSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const snapshot of history) {
    const distance = Math.abs(snapshot.observedAt.getTime() - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = snapshot;
    }
  }
  return bestDistance <= WINDOW_TOLERANCE_MS ? best : null;
}

function relativeChange(
  latest: PitSnapshot,
  earlier: PitSnapshot | null,
  pick: (s: PitSnapshot) => number | null,
  asOf: Date,
): Maybe<number> {
  const now = pick(latest);
  const then = earlier === null ? null : pick(earlier);
  if (now === null || then === null) return missing("NOT_YET_COLLECTED", asOf, null);
  // Ein Nenner von 0 ergaebe Unendlich, und Unendlich als Preisaenderung waere
  // eine Zahl, die durch jede Schwelle geht.
  if (then === 0) return missing("PARSE_FAILED", asOf, null);
  return observed(now / then - 1, providerId(latest.sourceProviderId ?? "unknown"), latest.observedAt);
}

function absoluteChange(
  latest: PitSnapshot,
  earlier: PitSnapshot | null,
  pick: (s: PitSnapshot) => number | null,
  asOf: Date,
): Maybe<number> {
  const now = pick(latest);
  const then = earlier === null ? null : pick(earlier);
  if (now === null || then === null) return missing("NOT_YET_COLLECTED", asOf, null);
  return observed(now - then, providerId(latest.sourceProviderId ?? "unknown"), latest.observedAt);
}
