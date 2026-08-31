import { StateMachine, type TransitionTable } from "@sae/core";

/**
 * Lebenszyklus eines Strategie-Kandidaten.
 *
 * §45 und §96 verlangen, dass eine neue Strategie nicht einfach „da" ist,
 * sondern eine nachvollziehbare Herkunft hat. Der Zustandsautomat ist die
 * technische Fassung des Satzes aus den Leitplanken: **keine Strategie darf
 * sich selbst scharfschalten.**
 *
 * Zwei Eigenschaften, die dafuer sorgen, dass die Kette nicht abgekuerzt werden
 * kann:
 *
 * 1. **Es gibt keinen Uebergang von `HYPOTHESIS` nach `PROMOTED`.** Auch nicht
 *    ueber Umwege — jede Stufe hat genau ihre erlaubten Nachfolger, und die
 *    Reihenfolge Backtest → Walk Forward → Out-of-Sample → Shadow ist
 *    erzwungen. Wer sie abkuerzen will, muss den Automaten aendern, und das
 *    faellt in einer Codeaenderung auf.
 * 2. **`PROMOTED` ist nicht „live".** Es heisst: alle Gates bestanden, ein
 *    Mensch kann sie jetzt scharfschalten. Das Scharfschalten selbst ist ein
 *    Vorgang an `strategy_versions` mit `activatedBy` — nicht an dieser
 *    Tabelle.
 *
 * `REJECTED` ist ein vollwertiges und haeufiges Ergebnis. Ein Kandidat, der in
 * der Out-of-Sample-Pruefung durchfaellt, ist kein Fehlschlag des Systems,
 * sondern seine Aufgabe.
 */

export type CandidateState =
  /** Aus der Forschung entstanden, noch nichts geprueft. */
  | "HYPOTHESIS"
  /** Backtest ueber den Trainingsbereich gelaufen. */
  | "BACKTESTED"
  /** Ueber rollierende Fenster geprueft. */
  | "WALK_FORWARDED"
  /** Gegen einen Zeitraum geprueft, der bei der Hypothese eingefroren war. */
  | "OUT_OF_SAMPLE_TESTED"
  /** Laeuft ohne Kapital neben dem Champion. */
  | "SHADOW_TRADING"
  /** Alle Gates bestanden. Ein Mensch kann sie scharfschalten. Endzustand. */
  | "PROMOTED"
  /** An einer Stufe gescheitert. Endzustand — und ein gutes Ergebnis. */
  | "REJECTED"
  /** Zurueckgestellt, etwa weil die Datengrundlage fehlt. Endzustand. */
  | "SHELVED";

const TABLE: TransitionTable<CandidateState> = {
  HYPOTHESIS: ["BACKTESTED", "REJECTED", "SHELVED"],
  BACKTESTED: ["WALK_FORWARDED", "REJECTED", "SHELVED"],
  WALK_FORWARDED: ["OUT_OF_SAMPLE_TESTED", "REJECTED", "SHELVED"],
  OUT_OF_SAMPLE_TESTED: ["SHADOW_TRADING", "REJECTED", "SHELVED"],
  SHADOW_TRADING: ["PROMOTED", "REJECTED", "SHELVED"],
  PROMOTED: [],
  REJECTED: [],
  SHELVED: [],
};

export const candidateStateMachine = new StateMachine<CandidateState>(
  "StrategyCandidateLifecycle",
  TABLE,
);

/** Die Pruefkette in ihrer Reihenfolge. Jede Stufe genau einmal. */
export const VALIDATION_CHAIN: readonly CandidateState[] = [
  "HYPOTHESIS",
  "BACKTESTED",
  "WALK_FORWARDED",
  "OUT_OF_SAMPLE_TESTED",
  "SHADOW_TRADING",
];

/** Zustaende, aus denen ein Kandidat noch weiterkommen kann. */
export function isInProgress(state: CandidateState): boolean {
  return VALIDATION_CHAIN.includes(state);
}

/**
 * Darf dieser Kandidat einem Menschen zum Scharfschalten vorgelegt werden?
 *
 * Genau ein Zustand — und selbst der bedeutet nur „vorlegbar", nicht „aktiv".
 */
export function isPromotable(state: CandidateState): boolean {
  return state === "PROMOTED";
}

export type CandidateOrigin =
  /** Aus einer Faktoranalyse ueber eigene Trades. */
  | "FEATURE_ANALYSIS"
  /** Aus der Auswertung abgelehnter Gelegenheiten. */
  | "REJECTION_ANALYSIS"
  /** Aus einer Parametervariation einer bestehenden Strategie. */
  | "PARAMETER_VARIATION"
  /** Von Hand formuliert. */
  | "MANUAL";

export interface StrategyCandidate {
  readonly candidateId: string;
  readonly state: CandidateState;
  readonly origin: CandidateOrigin;
  /**
   * Der Research-Batch, aus dem die Hypothese stammt.
   *
   * Pflicht: eine Hypothese ohne Batch hat keine eingefrorenen Zeitgrenzen, und
   * dann laesst sich nicht mehr sagen, ob die Out-of-Sample-Pruefung wirklich
   * ausserhalb lag (I-6).
   */
  readonly researchBatchId: string;
  /** Was behauptet wird, in einem Satz. */
  readonly hypothesis: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Auf welcher Version sie aufbaut. */
  readonly baseStrategyVersionId: string;
  readonly createdAt: Date;
  /** Warum abgelehnt oder zurueckgestellt. */
  readonly closedReason: string | null;
}

export class CandidateChainError extends Error {
  constructor(from: CandidateState, to: CandidateState) {
    super(
      `Kandidat kann nicht von ${from} nach ${to}: die Pruefkette laesst sich ` +
        "nicht abkuerzen.",
    );
    this.name = "CandidateChainError";
  }
}

/**
 * Naechster Zustand, oder Fehler.
 *
 * Bewusst kein `force`-Parameter. Eine Ausnahme, die man im Notfall setzen
 * kann, wird im Notfall gesetzt — und ein Notfall ist genau der Moment, in dem
 * eine ungepruefte Strategie am gefaehrlichsten ist.
 */
export function advanceCandidate(
  candidate: StrategyCandidate,
  to: CandidateState,
  closedReason: string | null = null,
): StrategyCandidate {
  if (!candidateStateMachine.canTransition(candidate.state, to)) {
    throw new CandidateChainError(candidate.state, to);
  }
  return { ...candidate, state: to, closedReason };
}
