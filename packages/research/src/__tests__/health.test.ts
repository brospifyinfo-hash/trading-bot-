import { describe, expect, it } from "vitest";

import {
  assessStrategyHealth,
  expectationFrom,
  healthStateMachine,
  planRollback,
  respondToDegradation,
  type HealthExpectation,
  type StrategyVersionRef,
} from "../health";
import { runMonteCarlo } from "../monte-carlo";

const expectation: HealthExpectation = {
  expectedWinRateLower: 0.4,
  expectedDrawdownP95: 0.3,
  expectedDrawdownWorst: 0.55,
  validationSampleSize: 400,
};

describe("Gesundheitszustaende", () => {
  it("laesst aus DEGRADED keinen direkten Weg zurueck nach HEALTHY", () => {
    // Eine Strategie, die ausserhalb ihrer Vorhersage lag, ist nicht dadurch
    // wieder gesund, dass die naechsten Trades besser liefen.
    expect(healthStateMachine.canTransition("DEGRADED", "HEALTHY")).toBe(false);
    expect(healthStateMachine.canTransition("DEGRADED", "WATCH")).toBe(true);
    expect(healthStateMachine.canTransition("WATCH", "HEALTHY")).toBe(true);
  });

  it("macht RETIRED endgueltig", () => {
    expect(healthStateMachine.isTerminal("RETIRED")).toBe(true);
  });
});

describe("Verschlechterung heisst ausserhalb der Vorhersage", () => {
  it("nennt einen erwarteten Rueckgang keine Verschlechterung", () => {
    // 28 % Rueckgang bei erwarteten 30 % im 95. Perzentil: das Modell wird
    // bestaetigt, nicht widerlegt. Hier abzuschalten hiesse, systematisch am
    // Tiefpunkt abzuschalten.
    const result = assessStrategyHealth({
      expectation,
      live: { trades: 200, wins: 90, maxDrawdown: 0.28 },
    });

    expect(result.state).toBe("WATCH");
    expect(result.mayAutoSuspend).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/engere Beobachtung/);
  });

  it("bleibt bei ruhigem Verlauf gesund", () => {
    const result = assessStrategyHealth({
      expectation,
      live: { trades: 200, wins: 100, maxDrawdown: 0.1 },
    });
    expect(result.state).toBe("HEALTHY");
  });

  it("erkennt eine Trefferquote, die selbst guenstig gelesen zu niedrig ist", () => {
    // 20 % bei 300 Trades: die Obergrenze des Intervalls liegt unter der
    // Validierungsuntergrenze. Ein blosser Unterschied der Punktschaetzungen
    // waere Rauschen.
    const result = assessStrategyHealth({
      expectation,
      live: { trades: 300, wins: 60, maxDrawdown: 0.2 },
    });

    expect(result.state).toBe("DEGRADED");
    expect(result.liveWinRateUpper!).toBeLessThan(expectation.expectedWinRateLower);
    expect(result.mayAutoSuspend).toBe(true);
  });

  it("nennt eine leicht schlechtere Trefferquote nicht degradiert", () => {
    // 36 % gegen erwartete 40 % Untergrenze — die Intervalle ueberlappen.
    const result = assessStrategyHealth({
      expectation,
      live: { trades: 200, wins: 72, maxDrawdown: 0.15 },
    });
    expect(result.state).toBe("HEALTHY");
  });

  it("wertet einen Rueckgang jenseits des schlechtesten Verlaufs als Modellwiderspruch", () => {
    const result = assessStrategyHealth({
      expectation,
      live: { trades: 200, wins: 100, maxDrawdown: 0.7 },
    });
    expect(result.state).toBe("DEGRADED");
    expect(result.reasons.join(" ")).toMatch(/widerlegt das Modell/);
  });

  it("urteilt bei zu wenigen Trades nicht — ausser der Rueckgang widerlegt das Modell", () => {
    const quiet = assessStrategyHealth({
      expectation,
      live: { trades: 10, wins: 1, maxDrawdown: 0.2 },
    });
    expect(quiet.state).toBe("HEALTHY");
    expect(quiet.reasons.join(" ")).toMatch(/kein Urteil/);

    const extreme = assessStrategyHealth({
      expectation,
      live: { trades: 10, wins: 1, maxDrawdown: 0.8 },
    });
    expect(extreme.state).toBe("DEGRADED");
  });

  it("baut die Erwartung aus Simulation und Validierung", () => {
    const steady = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? -0.2 : 0.15));
    const built = expectationFrom({
      monteCarlo: runMonteCarlo(steady, { paths: 300, seed: 8, stakeFraction: 0.02 }),
      validationWins: 200,
      validationTrades: 400,
    });
    expect(built).not.toBeNull();
    expect(built!.expectedWinRateLower).toBeGreaterThan(0.4);
    expect(built!.expectedWinRateLower).toBeLessThan(0.5);
  });

  it("liefert ohne belastbare Simulation keine Erwartung", () => {
    expect(
      expectationFrom({
        monteCarlo: runMonteCarlo([0.1, -0.1]),
        validationWins: 5,
        validationTrades: 10,
      }),
    ).toBeNull();
  });
});

describe("Rollback", () => {
  const day = (n: number): Date => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

  const history: StrategyVersionRef[] = [
    { versionId: "v1", activatedAt: day(0), retiredAt: day(30), retireReason: "REPLACED" },
    { versionId: "v2", activatedAt: day(30), retiredAt: day(60), retireReason: "DEGRADED" },
    { versionId: "v3", activatedAt: day(60), retiredAt: null, retireReason: null },
  ];

  it("schlaegt die juengste unbelastete Vorgaengerversion vor", () => {
    const plan = planRollback({
      current: history[2]!,
      history,
      reason: "Trefferquote ausserhalb der Vorhersage.",
    });

    expect(plan.kind).toBe("PROPOSED");
    if (plan.kind === "PROPOSED") {
      // v2 wurde selbst als degradiert stillgelegt und kommt nicht in Frage.
      expect(plan.targetVersionId).toBe("v1");
      expect(plan.requiresHumanApproval).toBe(true);
    }
  });

  it("ueberspringt Versionen, aus denen schon einmal zurueckgerollt wurde", () => {
    const withRollback: StrategyVersionRef[] = [
      { versionId: "v1", activatedAt: day(0), retiredAt: day(10), retireReason: "ROLLED_BACK_FROM" },
      { versionId: "v3", activatedAt: day(60), retiredAt: null, retireReason: null },
    ];
    // Sonst pendelt das System zwischen zwei Versionen und erzeugt bei jedem
    // Wechsel Kosten, ohne je zu entscheiden.
    expect(planRollback({ current: withRollback[1]!, history: withRollback, reason: "x" }).kind).toBe(
      "NO_TARGET",
    );
  });

  it("uebergeht nie aktivierte Versionen", () => {
    const neverLive: StrategyVersionRef[] = [
      { versionId: "draft", activatedAt: null, retiredAt: null, retireReason: null },
      { versionId: "v3", activatedAt: day(60), retiredAt: null, retireReason: null },
    ];
    expect(planRollback({ current: neverLive[1]!, history: neverLive, reason: "x" }).kind).toBe(
      "NO_TARGET",
    );
  });

  it("haelt an, schaltet aber nicht selbst um", () => {
    const assessment = assessStrategyHealth({
      expectation,
      live: { trades: 300, wins: 60, maxDrawdown: 0.2 },
    });
    const response = respondToDegradation({
      assessment,
      current: history[2]!,
      history,
    });

    // Anhalten schuetzt Kapital und ist automatisierbar. Aktivieren ist es
    // nicht — auch nicht das Zurueckschalten auf eine frueher gepruefte Version.
    expect(response.suspend).toBe(true);
    expect(response.rollback.kind).toBe("PROPOSED");
    if (response.rollback.kind === "PROPOSED") {
      expect(response.rollback.requiresHumanApproval).toBe(true);
    }
    expect(response.note).toMatch(/wartet auf eine Freigabe/);
  });

  it("haelt nicht an, wenn das Verhalten erwartbar ist", () => {
    const assessment = assessStrategyHealth({
      expectation,
      live: { trades: 200, wins: 100, maxDrawdown: 0.28 },
    });
    const response = respondToDegradation({ assessment, current: history[2]!, history });
    expect(response.suspend).toBe(false);
    expect(response.note).toMatch(/innerhalb der Vorhersage/);
  });
});
