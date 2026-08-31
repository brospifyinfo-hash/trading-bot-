import { DEFAULT_SYSTEM_STATE } from "@sae/config";

/**
 * Statusleiste.
 *
 * Zeigt die drei Stroeme getrennt: die beiden Paper-Stroeme laufen immer, Live
 * ist der einzige Schalter. Ein Nutzer muss jederzeit ohne Nachdenken erkennen
 * koennen, ob echtes Geld im Spiel ist — und es in einem Klick stoppen koennen.
 */
export function BotStatusBar() {
  const state = DEFAULT_SYSTEM_STATE;
  const isLive = state.liveTradingEnabled && !state.emergencyStop;

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
        <div className="label">Offene Positionen</div>
        <div className="value">0</div>
      </div>
      <div>
        <div className="label">Auto Paper</div>
        <span className="pill ok">laeuft</span>
      </div>
      <div>
        <div className="label">Manual Paper</div>
        <span className="pill ok">laeuft</span>
      </div>
      <div>
        <div className="label">Live</div>
        <span className={`pill ${isLive ? "live" : "paper"}`}>
          {isLive ? "aktiv" : "aus"}
        </span>
      </div>
      <button type="button" className="emergency">
        🛑 Emergency Stop
      </button>
    </header>
  );
}
