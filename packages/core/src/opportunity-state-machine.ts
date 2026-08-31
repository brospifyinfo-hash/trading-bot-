import { StateMachine, type TransitionTable } from "./state-machine";

/**
 * Lebenszyklus einer Handelsgelegenheit.
 *
 * BEWUSST GETRENNT von `TradeState`. Die beiden beantworten verschiedene Fragen:
 *
 *   TradeState        „ist die Transaktion on-chain bestaetigt?"
 *   OpportunityState  „hat der Mensch reagiert — und wie?"
 *
 * Ein gemeinsames Enum wuerde unmoegliche Uebergaenge erlauben (`SEEN → SUBMITTED`)
 * und jede Statistik mehrdeutig machen. Eine Opportunity, die zu einer Position
 * fuehrt, VERWEIST auf sie; sie wird nicht zu ihr.
 *
 * Gegenueber den neun Zustaenden aus Spec §63 sind es hier acht. Drei Paare
 * waren dort nicht trennscharf:
 *
 *   EXPIRED / MISSED        §65 nennt beide gemeinsam — dasselbe Ereignis.
 *                           MISSED ist deshalb hier keine State, sondern eine
 *                           Klassifikation (siehe `classifyMissed`).
 *   CONFIRMED / EXECUTED    EXECUTED ist ein Zustand der POSITION, nicht der
 *                           Opportunity. Hier endet sie bei POSITION_OPENED.
 *                           Der verbleibende Zustand heisst USER_CONFIRMED und
 *                           nicht CONFIRMED, weil `TradeState` denselben Namen
 *                           fuer etwas anderes benutzt ("on-chain bestaetigt").
 *                           Zwei Vokabulare mit einem gemeinsamen Wort sind in
 *                           Logs und Abfragen nicht auseinanderzuhalten — und
 *                           ein Filter ueber beide faellt nicht auf.
 *   CANCELLED / INVALIDATED §67 fuehrt zusaetzlich EXPIRED_BY_REVALIDATION ein —
 *                           ein vierter Begriff fuer denselben Bereich. Hier:
 *                           INVALIDATED = Nutzer war da, Revalidierung scheiterte.
 *                           CANCELLED   = System zieht zurueck, ohne Nutzer.
 */
export type OpportunityState =
  /** Erzeugt und dem Nutzer angeboten (Manual) bzw. bewertet (Auto). */
  | "OFFERED"
  /** Nutzer hat die Gelegenheit geoeffnet. Nur im Manual-Strom. */
  | "SEEN"
  /** Nutzer hat bestaetigt und die Revalidierung ist durchgelaufen. */
  | "USER_CONFIRMED"
  /** Aus der Bestaetigung ist eine Paper-Position entstanden. Endzustand. */
  | "POSITION_OPENED"
  /** Nutzer war verfuegbar und hat bewusst abgelehnt. Endzustand. */
  | "REJECTED"
  /** Nutzer war rechtzeitig da, aber die Revalidierung scheiterte. Endzustand. */
  | "INVALIDATED"
  /** Antwortfenster abgelaufen, keine Reaktion. Endzustand. */
  | "EXPIRED"
  /** System hat zurueckgezogen (Sicherheitsereignis o. ae.). Endzustand. */
  | "CANCELLED";

const TABLE: TransitionTable<OpportunityState> = {
  OFFERED: ["SEEN", "USER_CONFIRMED", "REJECTED", "EXPIRED", "CANCELLED"],
  // SEEN kann direkt ablaufen: gesehen heisst nicht gehandelt.
  SEEN: ["USER_CONFIRMED", "REJECTED", "INVALIDATED", "EXPIRED", "CANCELLED"],
  USER_CONFIRMED: ["POSITION_OPENED", "INVALIDATED"],
  POSITION_OPENED: [],
  REJECTED: [],
  INVALIDATED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const opportunityStateMachine = new StateMachine<OpportunityState>(
  "OpportunityLifecycle",
  TABLE,
);

/**
 * Zustaende, die eine Paper-Position erzeugen duerfen.
 *
 * Exakt einer. Diese Menge ist die technische Fassung von „MISSED ≠ LOSS" und
 * „USER_REJECTED ≠ LOSS": alles andere kann gar keine Position erzeugen, also
 * auch keine Performance-Zeile.
 */
const MAY_OPEN_POSITION: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  "USER_CONFIRMED",
]);

export const mayOpenPosition = (s: OpportunityState): boolean => MAY_OPEN_POSITION.has(s);

/**
 * Zustaende, in denen der Nutzer nachweislich verfuegbar war.
 *
 * Wichtig fuer die Auswertung: eine abgelehnte Gelegenheit sagt etwas ueber die
 * Strategie (der Nutzer sah sie und wollte nicht), eine abgelaufene sagt etwas
 * ueber die Erreichbarkeit. Beides in einen Topf zu werfen macht aus einem
 * Verfuegbarkeitsproblem einen Strategiefehler.
 */
const USER_WAS_AVAILABLE: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  "SEEN",
  "USER_CONFIRMED",
  "POSITION_OPENED",
  "REJECTED",
  "INVALIDATED",
]);

export const userWasAvailable = (s: OpportunityState): boolean => USER_WAS_AVAILABLE.has(s);

/** Endzustaende, die keine Position erzeugt haben. Forschungsmaterial. */
const CLOSED_WITHOUT_POSITION: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  "REJECTED",
  "INVALIDATED",
  "EXPIRED",
  "CANCELLED",
]);

export const closedWithoutPosition = (s: OpportunityState): boolean =>
  CLOSED_WITHOUT_POSITION.has(s);

/**
 * `MISSED` als Klassifikation statt als Zustand.
 *
 * Spec §66 will die verpassten Gelegenheiten auswerten — gemeint sind die, bei
 * denen eine Reaktion sich gelohnt haette. Das laesst sich erst NACH dem
 * Kursverlauf sagen, ist also kein Zustand, sondern ein Befund.
 *
 * Als eigener State waere die Zaehlung ausserdem von der Reihenfolge zweier
 * gleichbedeutender Zustaende abhaengig — und damit vom Zufall, welcher Job
 * zuerst lief.
 */
export function classifyMissed(input: {
  readonly state: OpportunityState;
  /** Hoechster hypothetischer Gewinn nach der Gelegenheit, als Anteil. */
  readonly hypotheticalMfe: number | null;
  /** Ab welchem Gewinn eine verpasste Gelegenheit als solche zaehlt. */
  readonly threshold: number;
}): boolean {
  if (input.state !== "EXPIRED") return false;
  if (input.hypotheticalMfe === null) return false;
  return input.hypotheticalMfe >= input.threshold;
}
