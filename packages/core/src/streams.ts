/**
 * Handelsstroeme.
 *
 * Ersetzt den frueheren Modus-Begriff (`execution: "paper" | "live"`), der Paper
 * und Live als sich AUSSCHLIESSENDE Alternativen fuehrte. Spezifikation §60 und
 * §138 verlangen das Gegenteil: Paper Trading laeuft immer — unabhaengig davon,
 * ob Auto, Manual oder Live aktiv ist, ob der Nutzer online ist oder ob echtes
 * Geld bewegt wird.
 *
 * Der Grund ist nicht Bequemlichkeit: „Paper" ist keine Betriebsart, sondern die
 * DATENERHEBUNG. Sie abschaltbar zu machen koppelt den Lernprozess an eine
 * Bedienentscheidung — und dann fehlen genau in den Phasen Daten, in denen
 * jemand das System aus Vorsicht ausgeschaltet hat. Also in den interessanten.
 */

export type TradingStream = "AUTO_PAPER" | "MANUAL_PAPER" | "LIVE";

/**
 * Stroeme, die niemals abschaltbar sind.
 *
 * Bewusst als Konstante und nicht als Konfiguration: eine Einstellung, die man
 * setzen kann, wird irgendwann gesetzt.
 */
export const ALWAYS_ON_STREAMS: readonly TradingStream[] = ["AUTO_PAPER", "MANUAL_PAPER"];

export function isAlwaysOn(stream: TradingStream): boolean {
  return ALWAYS_ON_STREAMS.includes(stream);
}

/** Bewegt dieser Strom echtes Kapital? */
export function usesRealCapital(stream: TradingStream): boolean {
  return stream === "LIVE";
}

/**
 * Wie eine Position dimensioniert wurde.
 *
 * Pflichtangabe an jeder Position, weil die beiden Verfahren VERSCHIEDENE
 * Renditeverteilungen erzeugen: ein fixer Betrag und eine nach Stop-Abstand
 * skalierte Groesse haben unterschiedliche Varianz, unterschiedlichen Drawdown
 * und unterschiedliches Ruin-Risiko. In einer Statistik gemischt ist jede
 * Kennzahl bedeutungslos — deshalb gibt es bewusst keine Aggregation ueber
 * beide (Spec §61 gegen §29, aufgeloest in §84).
 */
export type SizingMode = "FIXED_100" | "RISK_BASED";

/**
 * Betriebszustand des Systems.
 *
 * Die beiden Paper-Stroeme tauchen hier NICHT als Schalter auf — sie laufen.
 * Konfigurierbar ist nur, was echtes Geld betrifft und ob der Nutzer
 * Benachrichtigungen bekommt.
 */
export interface SystemState {
  /** Darf der Auto-Strom echtes Kapital einsetzen? Default aus. */
  readonly liveTradingEnabled: boolean;
  /** Werden Manual-Alerts versendet? Ohne sie laeuft MANUAL_PAPER trotzdem. */
  readonly manualAlertsEnabled: boolean;
  /** Globaler Notstopp. Haelt LIVE an, nicht die Datenerhebung. */
  readonly emergencyStop: boolean;
}

export const DEFAULT_SYSTEM_STATE: SystemState = {
  liveTradingEnabled: false,
  manualAlertsEnabled: true,
  emergencyStop: false,
};

/**
 * Darf dieser Strom gerade handeln?
 *
 * Die Paper-Stroeme sind auch beim Notstopp aktiv. Das ist Absicht: ein
 * Notstopp soll Kapital schuetzen, nicht die Beobachtung anhalten — sonst fehlt
 * ausgerechnet fuer die Phase, die den Stopp ausgeloest hat, die Datengrundlage.
 */
export function streamIsActive(stream: TradingStream, state: SystemState): boolean {
  if (isAlwaysOn(stream)) return true;
  return state.liveTradingEnabled && !state.emergencyStop;
}
