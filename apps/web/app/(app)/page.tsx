import { BotStatusBar } from "@/components/BotStatusBar";

/**
 * Dashboard-Gerüst.
 *
 * Dreiteilung wie ein Trading-Terminal: Scanner links, Analyse in der Mitte,
 * Trade-Setup rechts. Die Panels sind in Phase 1 leer — sie werden ab Phase 3
 * mit echten Daten gefuellt. Bewusst keine Beispieldaten: eine Oberflaeche, die
 * erfundene Zahlen zeigt, gewoehnt einen daran, ihnen zu glauben.
 */
export default function DashboardPage() {
  return (
    <>
      <BotStatusBar />
      <main className="workspace">
        <section className="panel">
          <h2>Market Scanner</h2>
          <p className="placeholder">Keine Daten — Discovery ab Phase 3.</p>
        </section>
        <section className="panel">
          <h2>Token-Analyse</h2>
          <p className="placeholder">Kein Token ausgewaehlt.</p>
        </section>
        <section className="panel">
          <h2>Trade-Setup &amp; Risiko</h2>
          <p className="placeholder">
            Live-Trading ist deaktiviert. Freigabe erst nach validierter Paper-Historie.
          </p>
        </section>
      </main>
    </>
  );
}
