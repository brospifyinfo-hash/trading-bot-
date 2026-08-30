/**
 * Authentifizierungsvertrag.
 *
 * Phase 1 legt die Schnittstelle fest, nicht die Implementierung. Entscheidend
 * ist die Trennung zweier Stufen: eine gueltige Session genuegt fuer Leserouten,
 * aber jede Handlung mit Kapitalwirkung verlangt eine frische 2FA-Bestaetigung
 * (Step-up). Ohne diese Trennung reicht ein gestohlenes Session-Cookie aus, um
 * Live-Trading zu aktivieren.
 */

export interface Session {
  readonly userId: string;
  readonly expiresAt: Date;
  /** Zeitpunkt der letzten 2FA-Bestaetigung. */
  readonly twoFactorAt: Date | null;
}

/** Handlungen, die eine frische 2FA-Bestaetigung verlangen. */
export const STEP_UP_ACTIONS = [
  "ENABLE_LIVE_TRADING",
  "CLEAR_EMERGENCY_STOP",
  "ACTIVATE_STRATEGY_VERSION",
  "RAISE_RISK_LIMIT",
  "CONFIRM_MANUAL_TRADE",
] as const;

export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

/** Wie frisch die 2FA-Bestaetigung sein muss. */
export const STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;

export function requiresStepUp(action: StepUpAction, session: Session, now: Date): boolean {
  void action;
  if (session.twoFactorAt === null) return true;
  return now.getTime() - session.twoFactorAt.getTime() > STEP_UP_MAX_AGE_MS;
}
