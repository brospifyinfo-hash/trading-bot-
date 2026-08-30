import { describe, expect, it } from "vitest";
import type { Bps } from "@sae/core";
import { evaluatePosition, type PositionState } from "../position-manager";
import type { PositionMarketState } from "../exit-rules";

const b = (n: number): Bps => n as Bps;

const position = (overrides: Partial<PositionState> = {}): PositionState => ({
  positionId: "pos-1",
  remainingBps: b(10_000),
  stopLossBps: b(2_000),
  trailingStopBps: b(1_500),
  takeProfits: [
    { index: 1, triggerGainBps: b(2_500), sellPortionBps: b(2_000), hit: false },
    { index: 2, triggerGainBps: b(5_000), sellPortionBps: b(2_000), hit: false },
    { index: 3, triggerGainBps: b(10_000), sellPortionBps: b(2_500), hit: false },
  ],
  maxHoldingSeconds: 86_400,
  ...overrides,
});

const market = (overrides: Partial<PositionMarketState> = {}): PositionMarketState => ({
  priceRatio: 1.05,
  highWaterRatio: 1.05,
  volumeAcceleration: 1.2,
  buyRatio: 0.55,
  liquidityRatio: 1,
  smartMoneySellers: 0,
  devSold: false,
  securityDowngraded: false,
  holdingSeconds: 600,
  ...overrides,
});

describe("Take Profit", () => {
  it("haelt unterhalb der ersten Stufe", () => {
    const d = evaluatePosition(position(), market({ priceRatio: 1.1, highWaterRatio: 1.1 }));
    expect(d.actions).toEqual([{ kind: "HOLD" }]);
  });

  it("loest die erste Stufe bei +25 Prozent aus", () => {
    const d = evaluatePosition(position(), market({ priceRatio: 1.25, highWaterRatio: 1.25 }));
    expect(d.actions).toEqual([{ kind: "SELL_PORTION", portionBps: 2_000, levelIndex: 1 }]);
  });

  it("loest bei einem Sprung mehrere Stufen gemeinsam aus", () => {
    // Memecoins springen. Wer nur die naechste Stufe nimmt, laesst die
    // uebersprungenen liegen und verkauft sie spaeter zu schlechteren Kursen.
    const d = evaluatePosition(position(), market({ priceRatio: 1.6, highWaterRatio: 1.6 }));
    expect(d.actions).toHaveLength(2);
    expect(d.actions.map((a) => (a.kind === "SELL_PORTION" ? a.levelIndex : null))).toEqual([1, 2]);
  });

  it("loest eine bereits ausgeloeste Stufe nicht erneut aus", () => {
    const p = position({
      takeProfits: [
        { index: 1, triggerGainBps: b(2_500), sellPortionBps: b(2_000), hit: true },
        { index: 2, triggerGainBps: b(5_000), sellPortionBps: b(2_000), hit: false },
      ],
      remainingBps: b(8_000),
    });
    const d = evaluatePosition(p, market({ priceRatio: 1.3, highWaterRatio: 1.3 }));
    expect(d.actions).toEqual([{ kind: "HOLD" }]);
  });

  it("verkauft nie mehr, als noch uebrig ist", () => {
    const p = position({ remainingBps: b(1_000) });
    const d = evaluatePosition(p, market({ priceRatio: 2, highWaterRatio: 2 }));
    const total = d.actions.reduce(
      (sum, a) => sum + (a.kind === "SELL_PORTION" ? a.portionBps : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(1_000);
  });
});

describe("Stop Loss und Trailing", () => {
  it("steigt beim Stop Loss vollstaendig aus", () => {
    const d = evaluatePosition(position(), market({ priceRatio: 0.79, highWaterRatio: 1.05 }));
    expect(d.actions).toEqual([{ kind: "EXIT_ALL", urgency: "NORMAL" }]);
  });

  it("hat Vorrang vor einer gleichzeitig erreichten TP-Stufe", () => {
    // Kann in einem Tick zusammenfallen. Verlustschutz ist das Dringendere.
    const p = position({ stopLossBps: b(2_000) });
    const d = evaluatePosition(p, market({ priceRatio: 0.7, highWaterRatio: 1.6 }));
    expect(d.actions).toEqual([{ kind: "EXIT_ALL", urgency: "NORMAL" }]);
  });

  it("steigt aus, wenn der Trailing Stop vom Hoechststand aus greift", () => {
    // Hoch bei 2.0, Trailing 15 % -> Ausstieg bei 1.70.
    const d = evaluatePosition(position(), market({ priceRatio: 1.69, highWaterRatio: 2 }));
    expect(d.actions).toEqual([{ kind: "EXIT_ALL", urgency: "NORMAL" }]);
  });

  it("laesst die Position knapp oberhalb des Trailing Stops laufen", () => {
    const d = evaluatePosition(
      position({ takeProfits: [] }),
      market({ priceRatio: 1.75, highWaterRatio: 2 }),
    );
    expect(d.actions).toEqual([{ kind: "HOLD" }]);
  });
});

describe("Risiko-Stops", () => {
  it("steigt bei Liquiditaetseinbruch sofort aus", () => {
    const d = evaluatePosition(position(), market({ priceRatio: 1.8, liquidityRatio: 0.3 }));
    expect(d.actions).toEqual([{ kind: "EXIT_ALL", urgency: "IMMEDIATE" }]);
  });

  it("steigt sofort aus, auch wenn die Position im Gewinn steht", () => {
    // Ein Liquiditaetsabzug ist ein Ereignis, keine Kursbewegung.
    const d = evaluatePosition(position(), market({ priceRatio: 3, devSold: true }));
    expect(d.actions[0]).toEqual({ kind: "EXIT_ALL", urgency: "IMMEDIATE" });
  });

  it("steigt bei verschlechtertem Sicherheitsstatus aus", () => {
    const d = evaluatePosition(position(), market({ securityDowngraded: true }));
    expect(d.actions[0]).toEqual({ kind: "EXIT_ALL", urgency: "IMMEDIATE" });
  });

  it("zieht bei aussteigendem Smart Money nur den Stop enger", () => {
    // Ein Signal, keine Notlage: ein weiterlaufender Kurs soll mitgenommen werden.
    const d = evaluatePosition(position(), market({ priceRatio: 1.2, smartMoneySellers: 4 }));
    expect(d.effectiveTrailingBps).toBe(500);
    expect(d.actions).toEqual([{ kind: "HOLD" }]);
  });
});

describe("Dynamischer Exit", () => {
  it("zieht bei Momentum-Einbruch den Stop enger", () => {
    const d = evaluatePosition(
      position(),
      market({ priceRatio: 1.4, highWaterRatio: 1.4, volumeAcceleration: 0.2 }),
    );
    expect(d.effectiveTrailingBps).toBe(400);
  });

  it("lockert den Stop bei anhaltendem Momentum", () => {
    const d = evaluatePosition(
      position({ takeProfits: [] }),
      market({ priceRatio: 1.8, highWaterRatio: 1.8, volumeAcceleration: 3, buyRatio: 0.72 }),
    );
    expect(d.effectiveTrailingBps).toBe(3_000);
  });

  it("lockert nicht, wenn gleichzeitig eine Regel verengen will", () => {
    // Im Zweifel schuetzen, nicht hoffen.
    const d = evaluatePosition(
      position({ takeProfits: [] }),
      market({
        priceRatio: 1.8,
        highWaterRatio: 1.8,
        volumeAcceleration: 3,
        buyRatio: 0.72,
        smartMoneySellers: 5,
      }),
    );
    expect(d.effectiveTrailingBps).toBe(500);
  });

  it("nimmt bei mehreren Verengungen die engste", () => {
    const d = evaluatePosition(
      position({ takeProfits: [] }),
      market({
        priceRatio: 1.4,
        highWaterRatio: 1.4,
        volumeAcceleration: 0.2,
        buyRatio: 0.1,
        smartMoneySellers: 0,
      }),
    );
    expect(d.effectiveTrailingBps).toBe(400);
  });

  it("steigt nach Ablauf der Haltedauer aus", () => {
    const d = evaluatePosition(
      position({ takeProfits: [] }),
      market({ priceRatio: 1.05, holdingSeconds: 90_000 }),
    );
    expect(d.actions).toEqual([{ kind: "EXIT_ALL", urgency: "NORMAL" }]);
  });
});

describe("Einzeln abschaltbare Regeln", () => {
  it("wendet nur die freigeschalteten Regeln an", () => {
    // Voraussetzung dafuer, dass der Backtest den Beitrag jeder Regel einzeln
    // messen kann. Ein Regelsatz, der nur als Ganzes schaltbar ist, ist nicht
    // auswertbar.
    const marketState = market({ priceRatio: 1.4, volumeAcceleration: 0.2 });
    const withRule = evaluatePosition(position(), marketState);
    const withoutRule = evaluatePosition(position(), marketState, { enabledRuleIds: [] });
    expect(withRule.effectiveTrailingBps).toBe(400);
    expect(withoutRule.effectiveTrailingBps).toBe(1_500);
  });

  it("meldet jede ausgeloeste Regel namentlich", () => {
    const d = evaluatePosition(position(), market({ liquidityRatio: 0.2, devSold: true }));
    expect(d.signals.map((s) => s.ruleId).sort()).toEqual([
      "RISK_DEV_SOLD",
      "RISK_LIQUIDITY_COLLAPSE",
    ]);
  });
});

describe("Determinismus", () => {
  it("liefert bei gleichem Zustand dieselbe Entscheidung", () => {
    const m = market({ priceRatio: 1.3, highWaterRatio: 1.5 });
    expect(evaluatePosition(position(), m)).toEqual(evaluatePosition(position(), m));
  });
});
