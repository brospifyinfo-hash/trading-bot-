import type { DecisionId, StrategyVersionId, TokenId } from "./ids";

/** Score 0..100, ganzzahlig. */
declare const brand: unique symbol;
export type Score = number & { readonly [brand]: "Score" };

export function score(value: number): Score {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`Score muss in [0,100] liegen, war ${value}`);
  }
  return Math.round(value) as Score;
}

export type SignalKind = "ENTER" | "WATCH" | "REJECT";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Gruende fuer eine Ablehnung — bewusst ein geschlossener Satz.
 *
 * Freitext waere hier bequem und wertlos: das Rejection-Log ist Forschungsmaterial
 * (welche Ablehnung war rueckblickend richtig?), und das setzt zaehlbare Kategorien
 * voraus. Ein neuer Grund erfordert eine Codeaenderung — das ist beabsichtigt.
 */
export type RejectionReason =
  | "CHEAP_SCREEN_FAILED"
  | "SECURITY_CRITICAL"
  | "SECURITY_SCORE_TOO_LOW"
  | "MINT_AUTHORITY_ACTIVE"
  | "FREEZE_AUTHORITY_ACTIVE"
  | "LIQUIDITY_TOO_LOW"
  | "LIQUIDITY_NOT_LOCKED"
  | "EXIT_CAPACITY_INSUFFICIENT"
  | "HOLDER_CONCENTRATION_TOO_HIGH"
  | "DEV_RUG_PATTERN"
  | "DEV_SCORE_TOO_LOW"
  | "SMART_MONEY_SCORE_TOO_LOW"
  | "SOCIAL_SCORE_TOO_LOW"
  | "MOMENTUM_SCORE_TOO_LOW"
  | "FINAL_SCORE_TOO_LOW"
  | "EXPECTED_EDGE_BELOW_COSTS"
  | "EV_NEGATIVE"
  | "EV_UNKNOWN_INSUFFICIENT_HISTORY"
  | "EXECUTION_COST_TOO_HIGH"
  | "SLIPPAGE_TOO_HIGH"
  | "PRICE_IMPACT_TOO_HIGH"
  | "POSITION_SIZE_BELOW_MINIMUM"
  | "MAX_OPEN_POSITIONS_REACHED"
  | "PORTFOLIO_EXPOSURE_LIMIT"
  | "DAILY_LOSS_LIMIT_REACHED"
  | "CONSECUTIVE_LOSS_LIMIT_REACHED"
  | "CIRCUIT_BREAKER_OPEN"
  | "DATA_INCOMPLETE"
  | "DATA_STALE"
  | "PROVIDER_UNHEALTHY"
  | "DUPLICATE_OPEN_INTENT"
  | "TOKEN_BLACKLISTED"
  | "LIVE_TRADING_DISABLED";

/** Ein einzelner nachvollziehbarer Grund fuer die getroffene Entscheidung. */
export interface Reason {
  readonly code: string;
  readonly detail: string;
}

/**
 * Ergebnis der Erwartungswertschaetzung.
 *
 * `UNKNOWN` ist ein eigener Fall und ausdruecklich nicht "null" oder "neutral":
 * solange keine belastbare eigene Verteilung existiert, ist der Erwartungswert
 * unbekannt — und unbekannt bedeutet im Auto-Modus kein Trade.
 */
export type EvEstimate =
  | {
      readonly kind: "ESTIMATED";
      /** Erwartungswert pro eingesetzter Einheit, nach Kosten. */
      readonly evPerUnit: number;
      /**
       * Wie schmal das Wilson-Intervall auf die Trefferquote ist, 0..1.
       *
       * Ausdruecklich NICHT „wie sicher ist der Fall": das ist
       * `caseConfidence` in `@sae/scoring` und zaehlt aehnliche historische
       * Faelle. Zwei Groessen, die beide „Confidence" hiessen, waeren im Alert
       * nicht auseinanderzuhalten (K-4).
       */
      readonly evIntervalConfidence: number;
      readonly sampleSize: number;
    }
  | {
      readonly kind: "UNKNOWN";
      readonly reason: "INSUFFICIENT_SAMPLE" | "NO_MATCHING_BUCKET" | "MODEL_NOT_CALIBRATED";
      readonly sampleSize: number;
    };

export interface SubScores {
  readonly security: Score;
  readonly liquidity: Score;
  readonly momentum: Score;
  readonly smartMoney: Score;
  readonly social: Score;
  readonly dev: Score;
  readonly holder: Score;
  readonly narrative: Score;
  readonly manipulation: Score;
  readonly execution: Score;
}

export interface Signal {
  readonly decisionId: DecisionId;
  readonly tokenId: TokenId;
  readonly kind: SignalKind;
  readonly finalScore: Score;
  readonly subScores: SubScores;
  readonly riskLevel: RiskLevel;
  readonly ev: EvEstimate;
  /** 0..1 — Anteil der tatsaechlich vorhandenen Inputs. */
  readonly dataCompleteness: number;
  readonly reasons: readonly Reason[];
  readonly risks: readonly Reason[];
  readonly rejectionReasons: readonly RejectionReason[];
  readonly scoreEngineVersion: string;
  readonly strategyVersionId: StrategyVersionId;
  readonly decidedAt: Date;
}

/** Ein CRITICAL-Sicherheitsbefund fuehrt ohne Ausnahme zu REJECT. */
export function riskLevelForcesReject(level: RiskLevel): boolean {
  return level === "CRITICAL";
}
