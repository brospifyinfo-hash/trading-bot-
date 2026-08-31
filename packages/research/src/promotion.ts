import type { FragilityAssessment } from "./fragility";
import type { MonteCarloResult } from "./monte-carlo";
import { ruinGate } from "./monte-carlo";
import type { ShadowComparison } from "./shadow";

/**
 * Die zehn Promotionsgates.
 *
 * §92, §94 und §130. Die entscheidende Eigenschaft steht nicht in der Liste,
 * sondern in ihrer Verknuepfung: **alle muessen bestehen, eines reicht zur
 * Ablehnung.** Es gibt keine Gewichtung und keinen Gesamtscore, gegen den sich
 * ein durchgefallenes Gate aufrechnen liesse.
 *
 * Der Grund ist der uebliche Verlauf: neun Gates bestanden, eines knapp
 * verfehlt, und die Versuchung, „im Schnitt sieht es doch gut aus" zu sagen,
 * ist gross. Ein Durchschnitt ueber Gates verwandelt jede harte Bedingung in
 * eine Empfehlung.
 *
 * Zweite Festlegung, die genauso wichtig ist: **dieses Modul kann keine
 * Freigabe erteilen.** Das zehnte Gate ist die menschliche Zustimmung, und es
 * gibt keinen Codepfad, der es auf `PASS` setzt. Das Ergebnis heisst deshalb
 * `readyForHumanReview` und nicht `approved` — der Unterschied ist nicht
 * sprachlich, sondern der ganze Zweck.
 *
 * Ein Gate, das mangels Daten nicht bewertet werden konnte, gilt als NICHT
 * bestanden. „Wir konnten es nicht pruefen" ist kein Argument dafuer, echtes
 * Geld einzusetzen.
 */

export type GateId =
  /** Genug aufgeloeste Trades, um ueberhaupt etwas zu sagen. */
  | "SAMPLE_SIZE"
  /** Gegen einen bei der Hypothese eingefrorenen Zeitraum geprueft. */
  | "OUT_OF_SAMPLE"
  /** In der Mehrzahl der rollierenden Fenster positiv, nicht in einem. */
  | "WALK_FORWARD_CONSISTENCY"
  /** Im paarweisen Vergleich belegt besser als der Champion. */
  | "SHADOW_BEATS_CHAMPION"
  /** Ergebnis haengt nicht an einzelnen Trades. */
  | "OUTLIER_ROBUSTNESS"
  /** Kein Parameter sitzt auf einer Spitze. */
  | "PARAMETER_SENSITIVITY"
  /** Ruinwahrscheinlichkeit unter der Grenze. */
  | "RISK_OF_RUIN"
  /** Simulierter Rueckgang innerhalb der Toleranz. */
  | "DRAWDOWN_LIMIT"
  /** Das Kostenmodell wurde gegen echte Ausfuehrungen kalibriert. */
  | "COST_MODEL_CALIBRATED"
  /** Ein Mensch hat zugestimmt. Wird hier nie gesetzt. */
  | "HUMAN_APPROVAL";

export const ALL_GATES: readonly GateId[] = [
  "SAMPLE_SIZE",
  "OUT_OF_SAMPLE",
  "WALK_FORWARD_CONSISTENCY",
  "SHADOW_BEATS_CHAMPION",
  "OUTLIER_ROBUSTNESS",
  "PARAMETER_SENSITIVITY",
  "RISK_OF_RUIN",
  "DRAWDOWN_LIMIT",
  "COST_MODEL_CALIBRATED",
  "HUMAN_APPROVAL",
];

export type GateStatus =
  | "PASS"
  | "FAIL"
  /** Nicht bewertbar. Zaehlt wie FAIL, wird aber getrennt ausgewiesen. */
  | "NOT_EVALUATED"
  /** Nur fuer HUMAN_APPROVAL: liegt ausserhalb dieses Systems. */
  | "REQUIRES_HUMAN";

export interface GateOutcome {
  readonly gate: GateId;
  readonly status: GateStatus;
  readonly detail: string;
}

export interface PromotionThresholds {
  readonly minResolvedTrades: number;
  /** Anteil der Walk-Forward-Fenster, der positiv sein muss. */
  readonly minPositiveWindowShare: number;
  /** Hoechster im 95. Perzentil simulierter Rueckgang. */
  readonly maxDrawdownP95: number;
}

/**
 * Startwerte, ausdruecklich als Festlegungen und nicht als Messungen.
 *
 * 200 aufgeloeste Trades sind die Untergrenze, unter der eine Trefferquote
 * Rauschen bleibt; zwei Drittel positive Fenster verlangen Bestaendigkeit ohne
 * Perfektion; 40 Prozent Rueckgang ist der Punkt, an dem die meisten Menschen
 * eine Strategie abschalten — und eine abgeschaltete Strategie hat keinen
 * Erwartungswert mehr.
 */
export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minResolvedTrades: 200,
  minPositiveWindowShare: 0.66,
  maxDrawdownP95: 0.4,
};

export interface PromotionEvidence {
  readonly candidateId: string;
  readonly resolvedTradeCount: number;
  /**
   * Ergebnis der Out-of-Sample-Pruefung. `null` heisst: nicht durchgefuehrt —
   * und damit nicht bestanden.
   */
  readonly outOfSample: { readonly netReturn: number; readonly batchId: string } | null;
  /** Anteil positiver Walk-Forward-Fenster. `null` = nicht durchgefuehrt. */
  readonly positiveWindowShare: number | null;
  readonly windowCount: number;
  readonly shadow: ShadowComparison | null;
  readonly fragility: FragilityAssessment | null;
  readonly monteCarlo: MonteCarloResult | null;
  /**
   * Ob das Kostenmodell gegen echte Ausfuehrungen kalibriert wurde.
   *
   * Solange kein Provider erreichbar ist, ist das `false` — und dieses Gate
   * faellt durch. Das ist beabsichtigt: eine Strategie, deren Kosten geschaetzt
   * sind, darf kein echtes Geld bewegen.
   */
  readonly costModelCalibrated: boolean;
}

export interface PromotionDecision {
  readonly candidateId: string;
  readonly gates: readonly GateOutcome[];
  readonly failed: readonly GateId[];
  readonly notEvaluated: readonly GateId[];
  /**
   * Alle Maschinen-Gates bestanden. Es fehlt nur noch ein Mensch.
   *
   * Bewusst NICHT `approved`: dieses Modul kann keine Freigabe erteilen.
   */
  readonly readyForHumanReview: boolean;
  readonly summary: string;
}

function outcome(gate: GateId, status: GateStatus, detail: string): GateOutcome {
  return { gate, status, detail };
}

export function evaluatePromotionGates(
  evidence: PromotionEvidence,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): PromotionDecision {
  const gates: GateOutcome[] = [];

  gates.push(
    evidence.resolvedTradeCount >= thresholds.minResolvedTrades
      ? outcome("SAMPLE_SIZE", "PASS", `${evidence.resolvedTradeCount} aufgeloeste Trades.`)
      : outcome(
          "SAMPLE_SIZE",
          "FAIL",
          `${evidence.resolvedTradeCount} von ${thresholds.minResolvedTrades} noetigen Trades.`,
        ),
  );

  gates.push(
    evidence.outOfSample === null
      ? outcome("OUT_OF_SAMPLE", "NOT_EVALUATED", "Keine Out-of-Sample-Pruefung durchgefuehrt.")
      : evidence.outOfSample.netReturn > 0
        ? outcome(
            "OUT_OF_SAMPLE",
            "PASS",
            `Out-of-Sample ${(evidence.outOfSample.netReturn * 100).toFixed(1)} % ` +
              `(Batch ${evidence.outOfSample.batchId}).`,
          )
        : outcome(
            "OUT_OF_SAMPLE",
            "FAIL",
            `Out-of-Sample ${(evidence.outOfSample.netReturn * 100).toFixed(1)} % — nicht positiv.`,
          ),
  );

  gates.push(
    evidence.positiveWindowShare === null
      ? outcome("WALK_FORWARD_CONSISTENCY", "NOT_EVALUATED", "Kein Walk Forward durchgefuehrt.")
      : evidence.positiveWindowShare >= thresholds.minPositiveWindowShare
        ? outcome(
            "WALK_FORWARD_CONSISTENCY",
            "PASS",
            `${(evidence.positiveWindowShare * 100).toFixed(0)} % von ${evidence.windowCount} Fenstern positiv.`,
          )
        : outcome(
            "WALK_FORWARD_CONSISTENCY",
            "FAIL",
            `Nur ${(evidence.positiveWindowShare * 100).toFixed(0)} % der Fenster positiv — ` +
              "ein Ergebnis aus wenigen guten Phasen.",
          ),
  );

  gates.push(
    evidence.shadow === null
      ? outcome("SHADOW_BEATS_CHAMPION", "NOT_EVALUATED", "Kein Shadow Trading durchgefuehrt.")
      : evidence.shadow.verdict === "CHALLENGER_BETTER"
        ? outcome("SHADOW_BEATS_CHAMPION", "PASS", evidence.shadow.note)
        : outcome(
            "SHADOW_BEATS_CHAMPION",
            evidence.shadow.verdict === "TOO_LITTLE_DATA" ? "NOT_EVALUATED" : "FAIL",
            evidence.shadow.note,
          ),
  );

  if (evidence.fragility === null) {
    gates.push(outcome("OUTLIER_ROBUSTNESS", "NOT_EVALUATED", "Keine Fragilitaetsanalyse."));
    gates.push(outcome("PARAMETER_SENSITIVITY", "NOT_EVALUATED", "Keine Fragilitaetsanalyse."));
  } else {
    const outliers = evidence.fragility.outliers;
    gates.push(
      outliers.verdict === "ROBUST"
        ? outcome("OUTLIER_ROBUSTNESS", "PASS", outliers.note)
        : outcome(
            "OUTLIER_ROBUSTNESS",
            outliers.verdict === "TOO_LITTLE_DATA" ? "NOT_EVALUATED" : "FAIL",
            outliers.note,
          ),
    );

    const peaks = evidence.fragility.parameters.filter((p) => p.shape === "PEAK");
    const unevaluable = evidence.fragility.parameters.filter((p) => p.shape === "NOT_EVALUABLE");
    gates.push(
      evidence.fragility.parameters.length === 0
        ? outcome("PARAMETER_SENSITIVITY", "NOT_EVALUATED", "Keine Parameter geprueft.")
        : unevaluable.length > 0
          ? outcome(
              "PARAMETER_SENSITIVITY",
              "NOT_EVALUATED",
              `${unevaluable.length} Parameter nicht auswertbar.`,
            )
          : peaks.length > 0
            ? outcome(
                "PARAMETER_SENSITIVITY",
                "FAIL",
                `${peaks.map((p) => p.parameter).join(", ")} sitzen auf einer Spitze.`,
              )
            : outcome(
                "PARAMETER_SENSITIVITY",
                "PASS",
                `${evidence.fragility.parameters.length} Parameter stabil bei ±5/10/20 %.`,
              ),
    );
  }

  if (evidence.monteCarlo === null) {
    gates.push(outcome("RISK_OF_RUIN", "NOT_EVALUATED", "Keine Monte-Carlo-Simulation."));
    gates.push(outcome("DRAWDOWN_LIMIT", "NOT_EVALUATED", "Keine Monte-Carlo-Simulation."));
  } else {
    const ruin = ruinGate(evidence.monteCarlo);
    gates.push(
      evidence.monteCarlo.verdict === "TOO_LITTLE_DATA"
        ? outcome("RISK_OF_RUIN", "NOT_EVALUATED", evidence.monteCarlo.note)
        : outcome("RISK_OF_RUIN", ruin.passed ? "PASS" : "FAIL", ruin.reason),
    );

    const drawdown = evidence.monteCarlo.drawdownP95;
    gates.push(
      drawdown === null
        ? outcome("DRAWDOWN_LIMIT", "NOT_EVALUATED", "Kein Rueckgang simuliert.")
        : drawdown <= thresholds.maxDrawdownP95
          ? outcome(
              "DRAWDOWN_LIMIT",
              "PASS",
              `Rueckgang im 95. Perzentil ${(drawdown * 100).toFixed(0)} %.`,
            )
          : outcome(
              "DRAWDOWN_LIMIT",
              "FAIL",
              `Rueckgang im 95. Perzentil ${(drawdown * 100).toFixed(0)} % ueber der Grenze ` +
                `von ${(thresholds.maxDrawdownP95 * 100).toFixed(0)} % — eine Strategie, die ` +
                "abgeschaltet wird, hat keinen Erwartungswert mehr.",
            ),
    );
  }

  gates.push(
    evidence.costModelCalibrated
      ? outcome("COST_MODEL_CALIBRATED", "PASS", "Kostenmodell gegen echte Ausfuehrungen geprueft.")
      : outcome(
          "COST_MODEL_CALIBRATED",
          "FAIL",
          "Kostenmodell beruht auf Annahmen — ohne Kalibrierung kein echtes Geld.",
        ),
  );

  // Kein Codepfad setzt dieses Gate auf PASS. Das ist der Sinn der Sache.
  gates.push(
    outcome(
      "HUMAN_APPROVAL",
      "REQUIRES_HUMAN",
      "Freigabe liegt ausserhalb dieses Systems und wird an strategy_versions vermerkt.",
    ),
  );

  const machineGates = gates.filter((g) => g.gate !== "HUMAN_APPROVAL");
  const failed = machineGates.filter((g) => g.status === "FAIL").map((g) => g.gate);
  const notEvaluated = machineGates.filter((g) => g.status === "NOT_EVALUATED").map((g) => g.gate);

  const readyForHumanReview = failed.length === 0 && notEvaluated.length === 0;

  return {
    candidateId: evidence.candidateId,
    gates,
    failed,
    notEvaluated,
    readyForHumanReview,
    summary: readyForHumanReview
      ? `Alle ${machineGates.length} Maschinen-Gates bestanden. Freigabe durch einen Menschen steht aus.`
      : `Nicht vorlegbar: ${failed.length} durchgefallen` +
        (notEvaluated.length > 0 ? `, ${notEvaluated.length} nicht bewertbar` : "") +
        ` (${[...failed, ...notEvaluated].join(", ")}).`,
  };
}
