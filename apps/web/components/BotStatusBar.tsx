import { DEFAULT_SYSTEM_STATE } from "@sae/config";
import type { PaperSummary } from "@sae/db";

/**
 * Statusleiste.
 *
 * Zeigt beobachteten Papierbestand je Strom. Ein eingeschalteter Modus ist
 * kein Beweis fuer einen laufenden Prozess. Der bisher wirkungslose
 * Notstopp-Knopf darf keine Bedienbarkeit behaupten.
 */
export function BotStatusBar({ paper }: { readonly paper: readonly PaperSummary[] }) {
  const state = DEFAULT_SYSTEM_STATE;
  const isLive = state.liveTradingEnabled && !state.emergencyStop;
  const open = (stream: string) => paper.filter((row) => row.stream === stream)
    .reduce((sum, row) => sum + row.openPositions, 0);

  return (
    <header className="statusbar">
      <div>
        <div className="label">Portfolio</div>
        <div className="value">—</div>
      </div>
      <div>
        <div className="label">PnL heute</div>
        <div className="value">—</div>
      </div>
      <div>
        <div className="label">Offene Papier-Positionen</div>
        <div className="value">{paper.reduce((sum, row) => sum + row.openPositions, 0)}</div>
      </div>
      <div>
        <div className="label">Auto Paper</div>
        <span className="pill paper">{open("AUTO_PAPER")} offen</span>
      </div>
      <div>
        <div className="label">Manual Paper</div>
        <span className="pill paper">{open("MANUAL_PAPER")} offen</span>
      </div>
      <div>
        <div className="label">Live</div>
        <span className={`pill ${isLive ? "live" : "paper"}`}>
          {isLive ? "aktiv" : "aus"}
        </span>
      </div>
      <button type="button" className="emergency" disabled title="Live-Ausfuehrung ist nicht implementiert. Dieser Knopf hat keine Stopp-Funktion.">
        Live-Ausfuehrung deaktiviert
      </button>
    </header>
  );
}
