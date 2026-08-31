/**
 * Scheduler mit getrennten Takten.
 *
 * Kein zentraler Tick, der alles anstoesst: die Aufgaben haben verschiedene
 * Dringlichkeiten und verschiedene Kosten. Discovery alle 30 Sekunden ist
 * sinnvoll, ein Research-Batch alle 30 Sekunden ist Unsinn — und beides aus
 * demselben Takt zu bedienen heisst, sich fuer den falschen zu entscheiden.
 *
 * Drei Eigenschaften, die dieses Modul von einem `setInterval` unterscheiden:
 *
 * 1. **Ohne Marktdaten laeuft fast nichts.** Jeder Takt sagt, ob er Marktdaten
 *    braucht. Solange keine Quelle verbunden ist, ist die Pipeline still — und
 *    genau ein Takt laeuft weiter: die Provider-Pruefung. Sie ist der
 *    Mechanismus, mit dem das System von selbst wieder anlaeuft.
 * 2. **Kein Nachholsturm.** War der Scheduler eine Stunde weg, feuert ein
 *    30-Sekunden-Takt genau EINMAL und nicht 120-mal. Nachgeholte Laeufe
 *    erzeugen nur Last und Daten, die niemand mehr braucht.
 * 3. **Rate Limits gehen vor.** Ein Takt, dessen geschaetzte Anfragen nicht ins
 *    verbleibende Budget passen, wird verschoben statt gedrosselt. Gedrosselt
 *    heisst: die Anfragen fehlen spaeter der Positionsueberwachung.
 */

export type CadenceId =
  /** Neue Tokens finden. */
  | "FAST_DISCOVERY"
  /** Marktdaten der beobachteten Tokens auffrischen. */
  | "MARKET_UPDATE"
  /** Offene Live-Positionen ueberwachen. */
  | "POSITION_MONITOR"
  /** Offene Paper-Positionen ueberwachen. */
  | "PAPER_MONITOR"
  /** Abgelaufene Manual-Gelegenheiten schliessen (I-11). */
  | "OPPORTUNITY_EXPIRY"
  /** Forschungslauf. */
  | "RESEARCH_BATCH"
  /** Gesundheit der laufenden Strategie. */
  | "STRATEGY_HEALTH"
  /** Erreichbarkeit der Provider. Laeuft immer. */
  | "PROVIDER_HEALTH"
  /** Bestandsabgleich. */
  | "RECONCILIATION";

export interface Cadence {
  readonly id: CadenceId;
  readonly intervalMs: number;
  /** Ohne verbundene Marktdatenquelle wird dieser Takt nicht faellig. */
  readonly requiresMarketData: boolean;
  /** Grobe Zahl der Anbieteranfragen je Lauf. Grundlage der Budgetpruefung. */
  readonly estimatedRequests: number;
  readonly description: string;
}

/**
 * Voreinstellungen.
 *
 * Die Intervalle sind Annahmen, keine Messungen — sie orientieren sich daran,
 * wie schnell sich der jeweilige Gegenstand aendert, nicht daran, wie schnell
 * Abfragen moeglich waeren. Sobald echte Rate Limits und echte Datenraten
 * bekannt sind, gehoeren sie ueberprueft.
 */
export const DEFAULT_CADENCES: readonly Cadence[] = [
  {
    id: "PROVIDER_HEALTH",
    intervalMs: 60_000,
    requiresMarketData: false,
    estimatedRequests: 1,
    description: "Prueft, ob eine Quelle erreichbar ist. Der Takt, der das System wieder anwirft.",
  },
  {
    id: "FAST_DISCOVERY",
    intervalMs: 30_000,
    requiresMarketData: true,
    estimatedRequests: 2,
    description: "Neue Tokens finden.",
  },
  {
    id: "MARKET_UPDATE",
    intervalMs: 20_000,
    requiresMarketData: true,
    estimatedRequests: 20,
    description: "Marktdaten der Beobachtungsliste auffrischen.",
  },
  {
    id: "POSITION_MONITOR",
    intervalMs: 10_000,
    requiresMarketData: true,
    estimatedRequests: 10,
    description: "Offene Live-Positionen. Kuerzester Takt, weil hier Geld liegt.",
  },
  {
    id: "PAPER_MONITOR",
    intervalMs: 15_000,
    requiresMarketData: true,
    estimatedRequests: 10,
    description: "Offene Paper-Positionen. Laeuft unabhaengig vom Live-Handel.",
  },
  {
    id: "OPPORTUNITY_EXPIRY",
    intervalMs: 30_000,
    requiresMarketData: false,
    estimatedRequests: 0,
    description: "Abgelaufene Gelegenheiten schliessen — zeitgesteuert, nicht beim naechsten Login.",
  },
  {
    id: "RECONCILIATION",
    intervalMs: 300_000,
    requiresMarketData: false,
    estimatedRequests: 5,
    description: "Bestandsabgleich zwischen Buchhaltung und Chain.",
  },
  {
    id: "STRATEGY_HEALTH",
    intervalMs: 900_000,
    requiresMarketData: false,
    estimatedRequests: 0,
    description: "Laeuft die aktive Strategie noch innerhalb ihrer Vorhersage?",
  },
  {
    id: "RESEARCH_BATCH",
    intervalMs: 21_600_000,
    requiresMarketData: false,
    estimatedRequests: 0,
    description: "Forschungslauf alle sechs Stunden. Braucht Daten, keine Frische.",
  },
];

export interface CadenceState {
  readonly id: CadenceId;
  readonly lastRunAt: Date | null;
  readonly lastOutcome: "OK" | "FAILED" | null;
  readonly consecutiveFailures: number;
}

export interface SchedulerInput {
  readonly cadences: readonly Cadence[];
  readonly states: ReadonlyMap<CadenceId, CadenceState>;
  readonly now: Date;
  /** Ob mindestens eine Marktdatenquelle verwertbare Daten liefert. */
  readonly marketDataAvailable: boolean;
  /** Verbleibende Anbieteranfragen im aktuellen Fenster. `null` = unbekannt. */
  readonly remainingRequests: number | null;
  /** Faktor fuer den Abstand nach Fehlschlaegen. */
  readonly failureBackoffFactor?: number;
  readonly maxFailureBackoff?: number;
}

export type CadenceDecision =
  | { readonly id: CadenceId; readonly kind: "RUN" }
  | { readonly id: CadenceId; readonly kind: "NOT_DUE"; readonly dueInMs: number }
  | { readonly id: CadenceId; readonly kind: "WAITING_FOR_MARKET_DATA" }
  | { readonly id: CadenceId; readonly kind: "DEFERRED_BUDGET"; readonly needed: number };

export interface SchedulerPlan {
  readonly decisions: readonly CadenceDecision[];
  readonly toRun: readonly CadenceId[];
  /** Geschaetzte Anfragen aller startenden Takte. */
  readonly plannedRequests: number;
  readonly waitingForMarketData: readonly CadenceId[];
}

/**
 * Was jetzt laufen soll.
 *
 * Reine Funktion ohne Timer: dieselbe Eingabe ergibt dieselbe Entscheidung, und
 * ein Test muss keine Sekunde warten.
 */
export function planTick(input: SchedulerInput): SchedulerPlan {
  const backoffFactor = input.failureBackoffFactor ?? 2;
  const maxBackoff = input.maxFailureBackoff ?? 8;

  const decisions: CadenceDecision[] = [];
  const toRun: CadenceId[] = [];
  const waitingForMarketData: CadenceId[] = [];
  let plannedRequests = 0;
  let remaining = input.remainingRequests;

  // Dringlichkeit zuerst: bei knappem Budget bekommt die Positionsueberwachung
  // ihre Anfragen, nicht die Discovery.
  const ordered = [...input.cadences].sort((a, b) => a.intervalMs - b.intervalMs);

  for (const cadence of ordered) {
    const state = input.states.get(cadence.id);

    if (cadence.requiresMarketData && !input.marketDataAvailable) {
      decisions.push({ id: cadence.id, kind: "WAITING_FOR_MARKET_DATA" });
      waitingForMarketData.push(cadence.id);
      continue;
    }

    const failures = state?.consecutiveFailures ?? 0;
    const penalty = Math.min(maxBackoff, backoffFactor ** Math.min(failures, 10));
    const effectiveInterval = cadence.intervalMs * (failures > 0 ? penalty : 1);

    const lastRunAt = state?.lastRunAt ?? null;
    const elapsed = lastRunAt === null ? Number.POSITIVE_INFINITY : input.now.getTime() - lastRunAt.getTime();

    if (elapsed < effectiveInterval) {
      decisions.push({
        id: cadence.id,
        kind: "NOT_DUE",
        dueInMs: Math.ceil(effectiveInterval - elapsed),
      });
      continue;
    }

    if (remaining !== null && cadence.estimatedRequests > remaining) {
      decisions.push({
        id: cadence.id,
        kind: "DEFERRED_BUDGET",
        needed: cadence.estimatedRequests,
      });
      continue;
    }

    decisions.push({ id: cadence.id, kind: "RUN" });
    toRun.push(cadence.id);
    plannedRequests += cadence.estimatedRequests;
    if (remaining !== null) remaining -= cadence.estimatedRequests;
  }

  return { decisions, toRun, plannedRequests, waitingForMarketData };
}

/**
 * Zustand nach einem Lauf.
 *
 * `lastRunAt` wird auf den TATSAECHLICHEN Zeitpunkt gesetzt und nicht auf den
 * geplanten. Damit gibt es keinen Nachholsturm: ein Takt, der eine Stunde
 * ausgefallen war, laeuft einmal und ist dann wieder im Takt.
 */
export function afterRun(
  state: CadenceState | undefined,
  id: CadenceId,
  at: Date,
  outcome: "OK" | "FAILED",
): CadenceState {
  return {
    id,
    lastRunAt: at,
    lastOutcome: outcome,
    consecutiveFailures: outcome === "FAILED" ? (state?.consecutiveFailures ?? 0) + 1 : 0,
  };
}

/** Takte, die ohne Marktdaten trotzdem laufen. Genau hier haengt der Wiederanlauf. */
export function alwaysRunningCadences(
  cadences: readonly Cadence[] = DEFAULT_CADENCES,
): readonly CadenceId[] {
  return cadences.filter((c) => !c.requiresMarketData).map((c) => c.id);
}
