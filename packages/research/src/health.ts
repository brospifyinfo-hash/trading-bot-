import { wilsonInterval } from "@sae/analytics";
import { StateMachine, type TransitionTable } from "@sae/core";

import type { MonteCarloResult } from "./monte-carlo";

/**
 * Gesundheit einer laufenden Strategie.
 *
 * §95, §108, §146 und §147. Der Kern ist eine Unterscheidung, an der die
 * meisten Systeme scheitern:
 *
 * **Ein Rueckgang innerhalb der erwarteten Bandbreite ist keine
 * Verschlechterung.** Die Monte-Carlo-Simulation hat vor der Freigabe gesagt,
 * dass 30 Prozent Drawdown in jedem zwanzigsten Verlauf vorkommen. Wenn er dann
 * eintritt, ist das die Bestaetigung des Modells und nicht sein Widerspruch.
 * Wer an dieser Stelle abschaltet, schaltet systematisch am Tiefpunkt ab — und
 * eine abgeschaltete Strategie hat keinen Erwartungswert mehr.
 *
 * Verschlechterung heisst deshalb: das Ergebnis liegt **ausserhalb** dessen,
 * was die Validierung vorhergesagt hat. Nicht: es ist negativ.
 *
 * Die zweite Festlegung betrifft die Richtung von Automatik:
 *
 *   Anhalten     darf das System selbst. Es schuetzt Kapital.
 *   Aktivieren   darf es nicht. Auch nicht das Zurueckschalten auf eine
 *                fruehere Version — die war einmal geprueft, aber ob sie zur
 *                heutigen Marktlage passt, hat niemand geprueft.
 *
 * Deshalb gibt es `suspend` als Vorgang und `planRollback` als Vorschlag.
 */

export type HealthState =
  /** Laeuft im erwarteten Rahmen. */
  | "HEALTHY"
  /** Auffaellig, aber noch innerhalb der Bandbreite. Engere Beobachtung. */
  | "WATCH"
  /** Ausserhalb der Vorhersage. Handel angehalten. */
  | "DEGRADED"
  /** Von Hand oder durch einen Vorfall angehalten. */
  | "SUSPENDED"
  /** Ersetzt. Endzustand. */
  | "RETIRED";

const TABLE: TransitionTable<HealthState> = {
  HEALTHY: ["WATCH", "DEGRADED", "SUSPENDED", "RETIRED"],
  WATCH: ["HEALTHY", "DEGRADED", "SUSPENDED", "RETIRED"],
  // Aus DEGRADED fuehrt kein Weg direkt zurueck nach HEALTHY: eine Strategie,
  // die ausserhalb ihrer Vorhersage lag, ist nicht dadurch wieder gesund, dass
  // die naechsten Trades besser liefen. Sie muss ueber WATCH zurueck.
  DEGRADED: ["WATCH", "SUSPENDED", "RETIRED"],
  SUSPENDED: ["WATCH", "RETIRED"],
  RETIRED: [],
};

export const healthStateMachine = new StateMachine<HealthState>("StrategyHealth", TABLE);

export interface HealthExpectation {
  /** Aus der Validierung: untere Konfidenzgrenze der Trefferquote. */
  readonly expectedWinRateLower: number;
  /** Aus der Monte-Carlo-Simulation. */
  readonly expectedDrawdownP95: number;
  readonly expectedDrawdownWorst: number;
  /** Wie viele Trades die Validierung getragen haben. */
  readonly validationSampleSize: number;
}

export function expectationFrom(input: {
  readonly monteCarlo: MonteCarloResult;
  readonly validationWins: number;
  readonly validationTrades: number;
}): HealthExpectation | null {
  if (input.monteCarlo.verdict !== "MEASURED" || input.validationTrades === 0) return null;
  return {
    expectedWinRateLower: wilsonInterval(input.validationWins, input.validationTrades).lower,
    expectedDrawdownP95: input.monteCarlo.drawdownP95 ?? 1,
    expectedDrawdownWorst: input.monteCarlo.drawdownWorst ?? 1,
    validationSampleSize: input.validationTrades,
  };
}

export interface LiveObservation {
  /** Abgeschlossene Trades seit der Freigabe. */
  readonly trades: number;
  readonly wins: number;
  /** Groesster bisheriger Rueckgang, als Anteil. */
  readonly maxDrawdown: number;
}

export interface HealthSettings {
  /** Unter dieser Zahl laufender Trades wird nicht geurteilt. */
  readonly minTradesForVerdict: number;
  /** Ab diesem Anteil des erwarteten P95-Rueckgangs: WATCH. */
  readonly watchDrawdownShare: number;
}

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  minTradesForVerdict: 50,
  watchDrawdownShare: 0.8,
};

export interface HealthAssessment {
  readonly state: HealthState;
  readonly reasons: readonly string[];
  /** Kennzahlen, auf denen das Urteil beruht. */
  readonly liveWinRate: number | null;
  readonly liveWinRateUpper: number | null;
  readonly expectedWinRateLower: number;
  readonly drawdownShareOfExpected: number;
  /**
   * Ob das System selbst anhalten darf.
   *
   * Anhalten schuetzt Kapital und ist deshalb automatisierbar. Wieder
   * einschalten ist es nicht.
   */
  readonly mayAutoSuspend: boolean;
}

export function assessStrategyHealth(input: {
  readonly expectation: HealthExpectation;
  readonly live: LiveObservation;
  readonly settings?: Partial<HealthSettings>;
}): HealthAssessment {
  const settings = { ...DEFAULT_HEALTH_SETTINGS, ...input.settings };
  const { expectation, live } = input;
  const reasons: string[] = [];

  const drawdownShare =
    expectation.expectedDrawdownP95 === 0
      ? 0
      : live.maxDrawdown / expectation.expectedDrawdownP95;

  if (live.trades < settings.minTradesForVerdict) {
    // Zu wenig gelaufen, um zu urteilen — aber ein Rueckgang jenseits des
    // simulierten schlechtesten Verlaufs ist auch dann ein Befund: er widerlegt
    // das Modell, nicht die Stichprobe.
    if (live.maxDrawdown > expectation.expectedDrawdownWorst) {
      return {
        state: "DEGRADED",
        reasons: [
          `Rueckgang ${(live.maxDrawdown * 100).toFixed(0)} % ueber dem schlechtesten ` +
            `simulierten Verlauf (${(expectation.expectedDrawdownWorst * 100).toFixed(0)} %).`,
        ],
        liveWinRate: live.trades === 0 ? null : live.wins / live.trades,
        liveWinRateUpper: null,
        expectedWinRateLower: expectation.expectedWinRateLower,
        drawdownShareOfExpected: drawdownShare,
        mayAutoSuspend: true,
      };
    }
    return {
      state: "HEALTHY",
      reasons: [`${live.trades} Trades — unter ${settings.minTradesForVerdict}, kein Urteil.`],
      liveWinRate: live.trades === 0 ? null : live.wins / live.trades,
      liveWinRateUpper: null,
      expectedWinRateLower: expectation.expectedWinRateLower,
      drawdownShareOfExpected: drawdownShare,
      mayAutoSuspend: false,
    };
  }

  const liveWinRate = live.wins / live.trades;
  const liveInterval = wilsonInterval(live.wins, live.trades);

  // Verschlechterung heisst: selbst die guenstigste Lesart der laufenden Zahlen
  // liegt unter der unguenstigsten Lesart der Validierung. Ein blosser
  // Unterschied der Punktschaetzungen ist Rauschen.
  const worseThanExpected = liveInterval.upper < expectation.expectedWinRateLower;
  const beyondWorstCase = live.maxDrawdown > expectation.expectedDrawdownWorst;
  const beyondP95 = live.maxDrawdown > expectation.expectedDrawdownP95;

  if (worseThanExpected) {
    reasons.push(
      `Trefferquote ${(liveWinRate * 100).toFixed(0)} % (Obergrenze ` +
        `${(liveInterval.upper * 100).toFixed(0)} %) unter der Validierungsuntergrenze ` +
        `${(expectation.expectedWinRateLower * 100).toFixed(0)} %.`,
    );
  }
  if (beyondWorstCase) {
    reasons.push(
      `Rueckgang ${(live.maxDrawdown * 100).toFixed(0)} % ueber dem schlechtesten ` +
        "simulierten Verlauf — das widerlegt das Modell.",
    );
  }

  if (worseThanExpected || beyondWorstCase) {
    return {
      state: "DEGRADED",
      reasons,
      liveWinRate,
      liveWinRateUpper: liveInterval.upper,
      expectedWinRateLower: expectation.expectedWinRateLower,
      drawdownShareOfExpected: drawdownShare,
      mayAutoSuspend: true,
    };
  }

  if (beyondP95) {
    reasons.push(
      `Rueckgang ${(live.maxDrawdown * 100).toFixed(0)} % ueber dem 95. Perzentil, aber ` +
        "innerhalb der simulierten Bandbreite — erwartbar, nicht auffaellig.",
    );
    return {
      state: "WATCH",
      reasons,
      liveWinRate,
      liveWinRateUpper: liveInterval.upper,
      expectedWinRateLower: expectation.expectedWinRateLower,
      drawdownShareOfExpected: drawdownShare,
      mayAutoSuspend: false,
    };
  }

  if (drawdownShare >= settings.watchDrawdownShare) {
    reasons.push(
      `Rueckgang bei ${(drawdownShare * 100).toFixed(0)} % des erwarteten P95 — engere Beobachtung.`,
    );
    return {
      state: "WATCH",
      reasons,
      liveWinRate,
      liveWinRateUpper: liveInterval.upper,
      expectedWinRateLower: expectation.expectedWinRateLower,
      drawdownShareOfExpected: drawdownShare,
      mayAutoSuspend: false,
    };
  }

  return {
    state: "HEALTHY",
    reasons: ["Innerhalb der Vorhersage."],
    liveWinRate,
    liveWinRateUpper: liveInterval.upper,
    expectedWinRateLower: expectation.expectedWinRateLower,
    drawdownShareOfExpected: drawdownShare,
    mayAutoSuspend: false,
  };
}

/* ---------------------------------------------------------------- Rollback */

export type RetireReason = "REPLACED" | "DEGRADED" | "ROLLED_BACK_FROM";

export interface StrategyVersionRef {
  readonly versionId: string;
  /** Wann sie scharfgeschaltet war. `null` = nie aktiv gewesen. */
  readonly activatedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly retireReason: RetireReason | null;
}

export type RollbackPlan =
  | {
      readonly kind: "PROPOSED";
      readonly targetVersionId: string;
      readonly reason: string;
      /**
       * Immer `true`. Ein Rollback ist eine Aktivierung, und Aktivierungen
       * laufen nicht automatisch — auch nicht auf eine frueher gepruefte
       * Version: geprueft wurde sie gegen eine andere Marktlage.
       */
      readonly requiresHumanApproval: true;
    }
  | { readonly kind: "NO_TARGET"; readonly reason: string };

/**
 * Schlaegt eine Vorgaengerversion vor.
 *
 * Uebersprungen werden Versionen, die selbst schon einmal zurueckgerollt
 * wurden: sonst pendelt das System zwischen zwei Versionen hin und her und
 * erzeugt bei jedem Wechsel Kosten, ohne je eine Entscheidung zu treffen.
 */
export function planRollback(input: {
  readonly current: StrategyVersionRef;
  readonly history: readonly StrategyVersionRef[];
  readonly reason: string;
}): RollbackPlan {
  const candidates = input.history
    .filter((v) => v.versionId !== input.current.versionId)
    .filter((v) => v.activatedAt !== null)
    .filter((v) => v.retireReason !== "ROLLED_BACK_FROM" && v.retireReason !== "DEGRADED")
    .sort((a, b) => (b.activatedAt!.getTime() - a.activatedAt!.getTime()));

  const target = candidates[0];
  if (target === undefined) {
    return {
      kind: "NO_TARGET",
      reason:
        "Keine frueher aktivierte Version ohne eigenen Rollback- oder Degradationsvermerk. " +
        "Anhalten ist dann die einzige sichere Massnahme.",
    };
  }

  return {
    kind: "PROPOSED",
    targetVersionId: target.versionId,
    reason: input.reason,
    requiresHumanApproval: true,
  };
}

/**
 * Was das System bei DEGRADED von sich aus tun darf.
 *
 * Genau eines: anhalten. Der Rollback wird vorgeschlagen und wartet.
 */
export interface DegradationResponse {
  readonly suspend: boolean;
  readonly rollback: RollbackPlan;
  readonly note: string;
}

export function respondToDegradation(input: {
  readonly assessment: HealthAssessment;
  readonly current: StrategyVersionRef;
  readonly history: readonly StrategyVersionRef[];
}): DegradationResponse {
  const rollback = planRollback({
    current: input.current,
    history: input.history,
    reason: input.assessment.reasons.join(" "),
  });
  return {
    suspend: input.assessment.mayAutoSuspend,
    rollback,
    note: input.assessment.mayAutoSuspend
      ? "Handel angehalten. Der Rollback ist ein Vorschlag und wartet auf eine Freigabe."
      : "Kein Anhalten noetig — das Verhalten liegt innerhalb der Vorhersage.",
  };
}
