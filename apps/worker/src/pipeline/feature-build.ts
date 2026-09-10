import { missing, observed, providerId, type Maybe, type ProviderId, type TokenId } from "@sae/core";
import type { PitReader, PitSecurity, PitSnapshot } from "@sae/db";
import type { FeatureVector } from "@sae/scoring";
import { bps, eur } from "@sae/core";
import { DEFAULT_FEES, DEFAULT_LATENCY, estimateExecutionCosts } from "@sae/simulation";

import { PAPER_NOTIONAL } from "./opportunity-pipeline";

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
  /** Ein Wert aus einem Snapshot, mit dessen Quelle und dessen Zeitpunkt. */
  const of = <T>(s: PitSnapshot, value: T | null): Maybe<T> =>
    value === null
      ? missing("NO_DATA_FOR_TOKEN", s.observedAt, source(s))
      : observed(value, source(s), s.observedAt);

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
      volumeAcceleration: volumeAcceleration(latest),
      buys5m: of(latest, latest.buys5m),
      sells5m: of(latest, latest.sells5m),
    },
    holder: {
      holders: of(latest, latest.holders),
      holderGrowth: absoluteChange(latest, anHourAgo, (s) => s.holders, asOf),
      distinctActors: notCollected(),
      largestClusterSharePct: notCollected(),
    },
    execution: {
      expectedCostBps: expectedCostBps(latest),
      // Braucht die Token-Reserve des Pools, um zu sagen, wie oft die Position
      // noch herausginge. Die liefert keine der heutigen Quellen — und aus der
      // Dollar-Liquiditaet zurueckzurechnen hiesse, eine Poolform anzunehmen.
      exitCapacityRatio: notCollected(),
      priceImpactBps: of(latest, latest.priceImpactBps),
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
    // Eine andere Frage als `top10`: dort steht die Summe der zehn groessten,
    // hier der eine, der allein verkaufen koennte.
    topHolderSharePct: of(security.topHolderSharePct),
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
  return observed(now / then - 1, source(latest), latest.observedAt);
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
  return observed(now - then, source(latest), latest.observedAt);
}

/**
 * Volumen der letzten fuenf Minuten im Verhaeltnis zum Durchschnitt.
 *
 * Eine MESSUNG, keine Schaetzung — und der Unterschied ist der Grund, warum
 * dieses Feld lange leer blieb. Beide Fenster stehen in derselben
 * Anbieterantwort und beziehen sich auf denselben Augenblick: `volume.m5` ist
 * das Volumen der letzten fuenf Minuten, `volume.h24 / 288` das
 * durchschnittliche Fuenf-Minuten-Volumen eines Tages (288 Fenster zu fuenf
 * Minuten). Ihr Verhaeltnis ist genau das, was das Feld verspricht.
 *
 * Die verworfene Alternative war, die Differenz zweier Staende des rollenden
 * 24-Stunden-Volumens als Zufluss zu lesen. Das haette bei jedem Takt eine
 * Zahl geliefert, aber eine andere Groesse gemessen — und sie haette der
 * richtigen zum Verwechseln aehnlich gesehen.
 *
 * `1` heisst „so viel wie ueblich", Werte darueber heissen Beschleunigung.
 */
function volumeAcceleration(latest: PitSnapshot): Maybe<number> {
  const fiveMinutes = latest.volume5mUsd;
  const day = latest.volume24hUsd;
  if (fiveMinutes === null || day === null) {
    return missing("NO_DATA_FOR_TOKEN", latest.observedAt, source(latest));
  }
  const average = day / WINDOWS_PER_DAY;
  // Ein Tagesvolumen von 0 hiesse: an diesem Markt wurde nichts gehandelt.
  // Dann gibt es keine Beschleunigung, sondern keinen Bezugspunkt.
  if (average <= 0) return missing("NO_DATA_FOR_TOKEN", latest.observedAt, source(latest));
  return observed(fiveMinutes / average, source(latest), latest.observedAt);
}

/** Fuenf-Minuten-Fenster eines Tages: 24 * 60 / 5. */
const WINDOWS_PER_DAY = 288;

/**
 * Die Quelle eines Datenpunkts.
 *
 * `unknown` nur fuer Zeilen aus der Zeit vor der Herkunftsverfolgung — es ist
 * eine ehrliche Angabe und kein Platzhalter, den jemand spaeter fuellt.
 */
function source(s: PitSnapshot): ProviderId {
  return providerId(s.sourceProviderId ?? "unknown");
}

/**
 * Erwartete Gesamtkosten einer Ausfuehrung, in Basispunkten.
 *
 * Gerechnet mit `estimateExecutionCosts` — demselben Kostenmodell, das auch
 * der simulierte Ausfuehrer benutzt. Eine zweite Formel an dieser Stelle waere
 * die teuerste Sorte Abweichung: der Score bewertete dann eine Ausfuehrung,
 * die anders abgerechnet wird als sie stattfindet.
 *
 * Der einzige GEMESSENE Eingang ist der Preiseinfluss aus dem Quote. Alles
 * andere sind erklaerte Annahmen (Gebuehren, Latenz, SOL-Preis, Einsatz) und
 * stehen als Konstanten an einer Stelle. Ohne den gemessenen Teil gibt es
 * keine Kostenschaetzung — die Annahmen allein ergaeben fuer jeden Token
 * dieselbe Zahl, und eine Konstante als Feature ist keine Information.
 */
function expectedCostBps(latest: PitSnapshot): Maybe<number> {
  const impact = latest.priceImpactBps;
  if (impact === null) return missing("NOT_YET_COLLECTED", latest.observedAt, source(latest));

  const estimate = estimateExecutionCosts({
    notional: PAPER_NOTIONAL,
    dexFeeBps: bps(DEX_FEE_BPS),
    priceImpactBps: bps(Math.round(impact)),
    solPrice: SOL_PRICE_ASSUMPTION,
    fees: DEFAULT_FEES,
    latency: DEFAULT_LATENCY,
  });
  return observed(estimate.totalBps, source(latest), latest.observedAt);
}

/**
 * Annahmen der Kostenrechnung — SIMULATIONSPARAMETER, keine Messwerte.
 *
 * Sie stehen hier zusammen und nicht verstreut, weil sie zusammen gelesen
 * werden muessen: wer den SOL-Preis anfasst, aendert jede Kostenschaetzung im
 * System. Der Wert ist eine grobe Annahme und ausdruecklich kein Kurs; sobald
 * ein SOL-Preis mit bekanntem Alter verfuegbar ist, gehoert er hierher.
 */
const SOL_PRICE_ASSUMPTION = eur(150);
/** Uebliche Pool-Gebuehr auf Solana-DEXen. */
const DEX_FEE_BPS = 25;
