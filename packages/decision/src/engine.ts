import type {
  DecisionId,
  EvEstimate,
  Reason,
  RejectionReason,
  Score,
  SignalKind,
  StrategyVersionId,
  TokenId,
} from "@sae/core";
import type { BreakerAssessment, SizingResult } from "@sae/risk";
import { evaluateHardGates, type GateContext } from "./hard-gates";
import type { EvDetail } from "./ev";

/**
 * Entscheidungsmaschine.
 *
 * Deterministisch. Gleiche Eingaben, gleiche Entscheidung — nachvollziehbar und
 * im Backtest exakt wiederholbar. Kein Modell, kein LLM und keine Heuristik
 * kann hier eine Ausnahme erzeugen; ein LLM liefert Features, nicht Urteile.
 *
 * Drei Zustaende:
 *   ENTER   — alle Bedingungen erfuellt
 *   WATCH   — interessant, aber (noch) nicht gut genug; wird weiter beobachtet
 *   REJECT  — mindestens ein Ausschlusskriterium greift
 *
 * WATCH ist kein Trostpreis: die Snapshot-Zeitreihe laeuft weiter, und genau
 * diese Tokens sind spaeter die Kontrollgruppe, an der sich messen laesst, ob
 * die Ablehnungen richtig waren.
 */

export type ExecutionMode = "paper" | "live";
export type DecisionMode = "manual" | "auto";

export interface DecisionContext extends GateContext {
  readonly decisionId: DecisionId;
  readonly strategyVersionId: StrategyVersionId;
  readonly executionMode: ExecutionMode;
  readonly decisionMode: DecisionMode;
  readonly liveTradingEnabled: boolean;
  readonly breakers: BreakerAssessment;
  readonly sizing: SizingResult;
  readonly ev: EvDetail;
  readonly exposureViolations: readonly RejectionReason[];
}

export interface Decision {
  readonly decisionId: DecisionId;
  readonly tokenId: TokenId;
  readonly kind: SignalKind;
  readonly finalScore: Score | null;
  readonly ev: EvEstimate;
  readonly dataCompleteness: number;
  readonly reasons: readonly Reason[];
  readonly risks: readonly Reason[];
  readonly rejectionReasons: readonly RejectionReason[];
  readonly scoreEngineVersion: string;
  readonly strategyVersionId: StrategyVersionId;
  readonly decidedAt: Date;
}

const reason = (code: string, detail: string): Reason => ({ code, detail });

export function decide(ctx: DecisionContext): Decision {
  const reasons: Reason[] = [];
  const risks: Reason[] = [];

  const base = {
    decisionId: ctx.decisionId,
    tokenId: ctx.features.tokenId,
    finalScore: ctx.scoring.finalScore,
    ev: ctx.ev.estimate,
    dataCompleteness: ctx.scoring.dataCompleteness,
    scoreEngineVersion: ctx.scoring.scoreEngineVersion,
    strategyVersionId: ctx.strategyVersionId,
    decidedAt: ctx.features.asOf,
  };

  // 1. Hard Gates. Kein Score kann sie ueberschreiben.
  const gates = evaluateHardGates(ctx);
  if (!gates.passed) {
    return {
      ...base,
      kind: "REJECT",
      reasons,
      risks,
      rejectionReasons: gates.failures,
    };
  }

  // 2. Circuit Breaker. Ausgeloest heisst: keine neuen Einstiege.
  if (ctx.breakers.entriesBlocked) {
    return {
      ...base,
      kind: "REJECT",
      reasons,
      risks: ctx.breakers.reasons.map((r) => reason("CIRCUIT_BREAKER", r)),
      rejectionReasons: ["CIRCUIT_BREAKER_OPEN"],
    };
  }

  // 3. Portfolio-Grenzen.
  if (ctx.exposureViolations.length > 0) {
    return {
      ...base,
      kind: "REJECT",
      reasons,
      risks,
      rejectionReasons: ctx.exposureViolations,
    };
  }

  // 4. Score-Schwelle. Darunter WATCH statt REJECT — der Token bleibt in der
  //    Beobachtung und liefert damit die Kontrollgruppe fuer die Forschung.
  const finalScore = ctx.scoring.finalScore;
  if (finalScore === null) {
    return {
      ...base,
      kind: "REJECT",
      reasons,
      risks,
      rejectionReasons: ["DATA_INCOMPLETE"],
    };
  }

  if (finalScore < ctx.parameters.entryGates.minFinalScore) {
    return {
      ...base,
      kind: "WATCH",
      reasons: [
        reason("BELOW_ENTRY_SCORE", `Score ${finalScore} unter Schwelle ${ctx.parameters.entryGates.minFinalScore}`),
      ],
      risks: ctx.scoring.drivers,
      rejectionReasons: [],
    };
  }

  // 5. Positionsgroesse. Zu klein heisst: die Kosten fressen den Trade auf.
  if (!ctx.sizing.tradeable) {
    return {
      ...base,
      kind: "REJECT",
      reasons,
      risks,
      rejectionReasons: ["POSITION_SIZE_BELOW_MINIMUM"],
    };
  }

  // 6. Erwartungswert.
  //
  // Der Bootstrap-Fall: ohne Historie gibt es keine Schaetzung, und ohne Trades
  // entsteht keine Historie. Aufgeloest wird das ueber den Modus — im
  // Paper-Betrieb ist UNKNOWN zulaessig, denn genau dort wird die Stichprobe
  // erzeugt. Im Live-Betrieb ist UNKNOWN ein Ausschlusskriterium: echtes Geld
  // wird nicht auf eine Groesse gesetzt, die niemand kennt.
  const evUnknown = ctx.ev.estimate.kind === "UNKNOWN";
  const isLive = ctx.executionMode === "live" && ctx.liveTradingEnabled;

  if (evUnknown) {
    if (isLive) {
      return {
        ...base,
        kind: "REJECT",
        reasons,
        risks,
        rejectionReasons: ["EV_UNKNOWN_INSUFFICIENT_HISTORY"],
      };
    }
    reasons.push(
      reason(
        "EV_UNKNOWN_PAPER",
        `Erwartungswert unbekannt (${ctx.ev.estimate.sampleSize} Trades) — im Paper-Betrieb zulaessig, um die Stichprobe aufzubauen`,
      ),
    );
  } else {
    const { evPerUnit, evIntervalConfidence } = ctx.ev.estimate;
    // Entschieden wird auf der konservativen Untergrenze, nicht auf der
    // Punktschaetzung: bei duenner Stichprobe ist die Punktschaetzung
    // schmeichelhaft und die Untergrenze ehrlich.
    if (evPerUnit <= 0) {
      return {
        ...base,
        kind: "REJECT",
        reasons,
        risks,
        rejectionReasons: ["EV_NEGATIVE"],
      };
    }
    if (isLive && evIntervalConfidence < ctx.parameters.entryGates.minEvConfidence) {
      return {
        ...base,
        kind: "REJECT",
        reasons,
        risks,
        rejectionReasons: ["EV_UNKNOWN_INSUFFICIENT_HISTORY"],
      };
    }
    reasons.push(
      reason(
        "POSITIVE_EV",
        `Konservativer Erwartungswert ${(evPerUnit * 100).toFixed(2)} % bei Intervallkonfidenz ${evIntervalConfidence.toFixed(2)}`,
      ),
    );
  }

  // 7. Live ohne bewusste Freischaltung ist immer eine Ablehnung.
  if (ctx.executionMode === "live" && !ctx.liveTradingEnabled) {
    return {
      ...base,
      kind: "REJECT",
      reasons,
      risks,
      rejectionReasons: ["LIVE_TRADING_DISABLED"],
    };
  }

  reasons.push(reason("SCORE_ABOVE_THRESHOLD", `Endscore ${finalScore}`));
  reasons.push(
    reason("SIZING_OK", `Position begrenzt durch ${ctx.sizing.bindingConstraint}`),
  );
  risks.push(...ctx.scoring.drivers);

  return {
    ...base,
    kind: "ENTER",
    reasons,
    risks,
    rejectionReasons: [],
  };
}
