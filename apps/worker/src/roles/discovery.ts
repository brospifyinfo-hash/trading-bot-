import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: discovery.
 *
 * Diese Rolle laeuft absichtlich leer — die Token-Entdeckung findet nicht hier
 * statt, sondern im consumer. Der Weg ist:
 *
 *   scheduler → Takt `FAST_DISCOVERY` → Auftrag `DISCOVER_TOKENS`
 *             → job_queue → consumer → `runTokenDiscovery`
 *
 * Der Grund ist der gleiche wie ueberall in dieser Architektur: der Scheduler
 * reiht ein, er arbeitet nicht. Liefe die Discovery zusaetzlich in einem
 * eigenen Dienst, gaebe es zwei Takte fuer dieselbe Arbeit — doppelte
 * Anbieteranfragen, und zwei Prozesse, die gleichzeitig dieselben Zeilen
 * anlegen wollen. Der Unique-Index auf `mint` faenge das ab, aber die
 * Anfragen waeren schon verbraucht.
 *
 * Der Dienst bleibt bestehen, weil `WORKER_ROLE=discovery` eine gueltige
 * Einstellung ist und ein stiller Start weniger verwirrt als ein Absturz. Er
 * sagt beim Start, wo die Arbeit tatsaechlich passiert.
 */
export const discoveryRole: RoleHandler = {
  name: "discovery",
  async start(ctx: RoleContext): Promise<void> {
    ctx.logger.info(
      { role: "discovery" },
      "Rolle gestartet — die Token-Entdeckung laeuft als Auftrag DISCOVER_TOKENS im consumer, nicht hier",
    );
  },
  async stop(): Promise<void> {
    // Nichts zu tun: dieser Dienst haelt keine Zeitgeber und keine Verbindung.
  },
};
