import { describe, expect, it } from "vitest";

import { PAPER_PROFILES } from "../memecoin-paper";

/**
 * Die Schwellen, die nirgends standen.
 *
 * `paperLaunchMinBuys` und `paperLaunchMaxAgeSeconds` waren im Schema
 * optional, und die Pipeline setzte an der Benutzungsstelle `?? 3` und
 * `?? 60` ein. „Offensiv" schaltete den Launch-Modus ein, ohne beide zu
 * setzen — und lief damit auf einem 60-Sekunden-Frischefenster, das in seinem
 * Profil nirgends zu lesen war. Es war damit beim Datenalter STRENGER als
 * „Sehr offensiv" mit seinen ausdruecklichen 120 Sekunden, also genau
 * umgekehrt zu dem, was die Namen versprechen.
 *
 * Ein Ersatzwert an der Benutzungsstelle ist keine Voreinstellung, sondern
 * eine zweite, unsichtbare Konfiguration. Dieser Test verlangt, dass ein
 * Launch-Profil seine Schwellen selbst traegt.
 */
describe("Papier-Profile", () => {
  for (const { label, candidate } of PAPER_PROFILES) {
    const gates = candidate.parameters.entryGates;
    if (gates.paperLaunchMode !== true) continue;

    it(`${label}: nennt seine Launch-Schwellen selbst`, () => {
      expect(gates.paperLaunchMinBuys, "paperLaunchMinBuys").not.toBeUndefined();
      expect(gates.paperLaunchMaxAgeSeconds, "paperLaunchMaxAgeSeconds").not.toBeUndefined();
    });
  }

  it("haelt die Reihenfolge der Profile ein: offensiver heisst nicht strenger", () => {
    const launch = PAPER_PROFILES.filter((p) => p.candidate.parameters.entryGates.paperLaunchMode === true);
    expect(launch.length).toBeGreaterThanOrEqual(2);

    // Die Einstiegsschwelle sinkt von Profil zu Profil — das ist die
    // Bedeutung von „offensiver". Jede andere Schwelle, die sich dabei
    // verschaerft, waere eine Ueberraschung und gehoert begruendet.
    const scores = launch.map((p) => p.candidate.parameters.entryGates.minFinalScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
