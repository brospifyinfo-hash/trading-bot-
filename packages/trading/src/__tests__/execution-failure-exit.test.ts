import { describe, expect, it } from "vitest";
import type { Bps } from "@sae/core";

import {
  EXECUTION_FAILURE,
  NO_EXECUTION_FAILURES,
  assessExecutionFailure,
  isMarketSideFailure,
  type ExitExecutionState,
} from "../execution-failure-exit";
import { ALL_EXIT_RULES, type ExitRuleContext, type PositionMarketState } from "../exit-rules";

const market: PositionMarketState = {
  priceRatio: 1.2,
  highWaterRatio: 1.3,
  volumeAcceleration: 1.1,
  buyRatio: 0.6,
  liquidityRatio: 1.0,
  smartMoneySellers: 0,
  devSold: false,
  securityDowngraded: false,
  holdingSeconds: 600,
};

function state(overrides: Partial<ExitExecutionState> = {}): ExitExecutionState {
  return { ...NO_EXECUTION_FAILURES, ...overrides };
}

function ctx(execution: ExitExecutionState | null): ExitRuleContext {
  return {
    market,
    currentTrailingBps: 1_500 as Bps,
    maxHoldingSeconds: 86_400,
    execution,
  };
}

describe("Fehlerklassen", () => {
  it("trennt marktseitige von betrieblichen Ursachen", () => {
    expect(isMarketSideFailure("SLIPPAGE_EXCEEDED")).toBe(true);
    expect(isMarketSideFailure("NO_ROUTE")).toBe(true);
    expect(isMarketSideFailure("BLOCKHASH_EXPIRED")).toBe(true);
    expect(isMarketSideFailure("RPC_UNAVAILABLE")).toBe(false);
    expect(isMarketSideFailure("INSUFFICIENT_FEE_BALANCE")).toBe(false);
    expect(isMarketSideFailure("POLICY_REJECTED")).toBe(false);
  });
});

describe("Marktseitige Fehlschlaege", () => {
  it("eskalieren nach mehreren Versuchen zum gestueckelten Ausstieg", () => {
    const result = assessExecutionFailure(
      state({
        consecutiveFailures: 3,
        consecutiveMarketSideFailures: 3,
        lastFailureKind: "SLIPPAGE_EXCEEDED",
        secondsSinceFirstFailure: 45,
      }),
    );
    expect(result.kind).toBe("ESCALATE_TO_TRANCHED_EXIT");
  });

  it("eskalieren auch, wenn die Serie lange genug dauert", () => {
    const result = assessExecutionFailure(
      state({
        consecutiveFailures: 2,
        consecutiveMarketSideFailures: 2,
        lastFailureKind: "NO_ROUTE",
        secondsSinceFirstFailure: 180,
      }),
    );
    // Zwei Versuche unter der Zahlschwelle, aber drei Minuten ohne Ausstieg.
    expect(result.kind).toBe("ESCALATE_TO_TRANCHED_EXIT");
  });

  it("eskalieren nicht beim ersten Fehlschlag", () => {
    expect(
      assessExecutionFailure(
        state({
          consecutiveFailures: 1,
          consecutiveMarketSideFailures: 1,
          lastFailureKind: "SLIPPAGE_EXCEEDED",
          secondsSinceFirstFailure: 5,
        }),
      ).kind,
    ).toBe("NO_ACTION");
  });
});

describe("Betriebliche Fehlschlaege", () => {
  it("loesen keinen Verkauf aus", () => {
    // Der Fall, der das Portfolio kostet: ein RPC-Ausfall wie ueberschrittene
    // Slippage gezaehlt, und jede offene Position steigt gleichzeitig
    // gestueckelt aus — ausgerechnet dann, wenn niemand zuverlaessig handeln
    // kann.
    const result = assessExecutionFailure(
      state({
        consecutiveFailures: 8,
        consecutiveMarketSideFailures: 0,
        lastFailureKind: "RPC_UNAVAILABLE",
        secondsSinceFirstFailure: 600,
      }),
    );

    expect(result.kind).toBe("OPERATIONAL_ALARM");
    if (result.kind === "OPERATIONAL_ALARM") {
      expect(result.failureKind).toBe("RPC_UNAVAILABLE");
      // Ein Knoten, der nicht antwortet, ist kein Grund zu verkaufen.
      expect(result.haltNewEntries).toBe(false);
    }
  });

  it("halten neue Einstiege an, wenn gar nicht mehr gehandelt werden kann", () => {
    const result = assessExecutionFailure(
      state({
        consecutiveFailures: 2,
        consecutiveMarketSideFailures: 0,
        lastFailureKind: "INSUFFICIENT_FEE_BALANCE",
        secondsSinceFirstFailure: 30,
      }),
    );

    expect(result.kind).toBe("OPERATIONAL_ALARM");
    if (result.kind === "OPERATIONAL_ALARM") {
      // Wer nicht aussteigen kann, darf nicht einsteigen.
      expect(result.haltNewEntries).toBe(true);
    }
  });

  it("behandeln eine Policy-Ablehnung als Alarm, nicht als Ausstiegsgrund", () => {
    const result = assessExecutionFailure(
      state({
        consecutiveFailures: 4,
        consecutiveMarketSideFailures: 0,
        lastFailureKind: "POLICY_REJECTED",
        secondsSinceFirstFailure: 60,
      }),
    );

    // Und ausdruecklich nicht: die Policy lockern, um herauszukommen.
    expect(result.kind).toBe("OPERATIONAL_ALARM");
    if (result.kind === "OPERATIONAL_ALARM") {
      expect(result.haltNewEntries).toBe(true);
    }
  });
});

describe("Als Regel im Regelsatz", () => {
  it("steht im Regelsatz", () => {
    expect(ALL_EXIT_RULES.map((r) => r.id)).toContain("DYN_EXECUTION_FAILURE");
  });

  it("schweigt ohne bekannte Fehlschlaege", () => {
    expect(EXECUTION_FAILURE.evaluate(ctx(null))).toBeNull();
    expect(EXECUTION_FAILURE.evaluate(ctx(NO_EXECUTION_FAILURES))).toBeNull();
  });

  it("gibt bei marktseitiger Eskalation ein Sofortsignal", () => {
    const signal = EXECUTION_FAILURE.evaluate(
      ctx(
        state({
          consecutiveFailures: 3,
          consecutiveMarketSideFailures: 3,
          lastFailureKind: "SLIPPAGE_EXCEEDED",
          secondsSinceFirstFailure: 40,
        }),
      ),
    );
    expect(signal?.action).toEqual({ kind: "EXIT_ALL", urgency: "IMMEDIATE" });
  });

  it("gibt bei einem Betriebsalarm KEIN Ausstiegssignal", () => {
    // Verkauft wird, weil der Markt sich gedreht hat — nicht weil ein Knoten
    // nicht antwortet.
    const signal = EXECUTION_FAILURE.evaluate(
      ctx(
        state({
          consecutiveFailures: 5,
          consecutiveMarketSideFailures: 0,
          lastFailureKind: "RPC_UNAVAILABLE",
          secondsSinceFirstFailure: 300,
        }),
      ),
    );
    expect(signal).toBeNull();
  });
});
