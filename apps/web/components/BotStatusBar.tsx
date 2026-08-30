import { DEFAULT_BOT_MODE } from "@sae/config";

/**
 * Statusleiste.
 *
 * Modus und Emergency Stop sind ab dem ersten Tag sichtbar. Ein Nutzer muss
 * jederzeit ohne Nachdenken erkennen koennen, ob echtes Geld im Spiel ist —
 * und ihn in einem Klick stoppen koennen.
 */
export function BotStatusBar() {
  const mode = DEFAULT_BOT_MODE;
  const isLive = mode.execution === "live" && mode.liveTradingEnabled;

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
        <div className="label">Ausfuehrung</div>
        <span className={`pill ${isLive ? "live" : "paper"}`}>
          {isLive ? "Live" : "Paper"}
        </span>
      </div>
      <div>
        <div className="label">Entscheidung</div>
        <span className="pill ok">{mode.decision === "auto" ? "Auto" : "Manual"}</span>
      </div>
      <button type="button" className="emergency">
        🛑 Emergency Stop
      </button>
    </header>
  );
}
