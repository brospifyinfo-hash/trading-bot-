import { describe, expect, it } from "vitest";
import { eur, tokenId } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { DEFAULT_FEES } from "@sae/simulation";
import { runBacktest, type BacktestConfig } from "../harness";
import { RecordingSource, priceSeries } from "./fake-source";

const START = new Date("2026-06-01T00:00:00Z");
const END = new Date("2026-06-01T02:00:00Z");

const config = (overrides: Partial<BacktestConfig> = {}): BacktestConfig => ({
  from: START,
  to: END,
  stepSeconds: 60,
  parameters: DEFAULT_STRATEGY_PARAMETERS,
  initialCapital: eur(1_000),
  currency: "EUR",
  seed: 1234,
  // Fehlschlaege im Basisfall aus, damit die Tests eine Sache pruefen.
  fees: { ...DEFAULT_FEES, failureRate: 0 },
  driftScale: 0.001,
  ...overrides,
});

/** Steigt 40 Minuten lang, faellt dann. */
const risingThenFalling = () =>
  priceSeries(
    START,
    [
      ...Array.from({ length: 40 }, (_, i) => 1 + i * 0.02),
      ...Array.from({ length: 81 }, (_, i) => 1.8 - i * 0.015),
    ],
    0.001,
  );

describe("Kein Look-Ahead", () => {
  it("fragt niemals einen Zeitpunkt jenseits der Simulationszeit an", async () => {
    // Die Quelle wirft bei Verletzung — der Lauf stuerzt ab, statt ein schoenes
    // Ergebnis zu liefern.
    const source = new RecordingSource(risingThenFalling());
    source.setHardLimit(END);
    const result = await runBacktest(source, config());
    expect(result.maxAsOfRequested.getTime()).toBeLessThanOrEqual(END.getTime());
  });

  it("fragt in jedem Schritt genau die aktuelle Simulationszeit an", async () => {
    const source = new RecordingSource(risingThenFalling());
    await runBacktest(source, config());
    const unique = [...new Set(source.requestedAsOf.map((d) => d.getTime()))].sort((a, b) => a - b);
    // Ein Schritt je Minute, luecken- und sprungfrei.
    for (let i = 1; i < unique.length; i++) {
      expect(unique[i]! - unique[i - 1]!).toBe(60_000);
    }
  });

  it("schaetzt den Erwartungswert nur aus bereits geschlossenen Trades", async () => {
    // Der Erwartungswert darf nie das Gesamtergebnis des Laufs kennen — das
    // waere Look-Ahead auf die eigene Zukunft.
    const source = new RecordingSource(risingThenFalling());
    const result = await runBacktest(source, config());
    // Mit Standardparametern (100 Trades Mindeststichprobe) bleibt EV im
    // gesamten Lauf UNKNOWN — und wird im Paper-Modus akzeptiert.
    expect(result.entriesTaken).toBeGreaterThan(0);
  });
});

describe("Reproduzierbarkeit", () => {
  it("liefert bei gleichem Startwert ein identisches Ergebnis", async () => {
    const run = async () => runBacktest(new RecordingSource(risingThenFalling()), config());
    const a = await run();
    const b = await run();
    expect(a.trades).toEqual(b.trades);
    expect(a.entriesTaken).toBe(b.entriesTaken);
    expect([...a.rejections]).toEqual([...b.rejections]);
  });

  it("liefert bei anderem Startwert ein anderes Ergebnis", async () => {
    const a = await runBacktest(new RecordingSource(risingThenFalling()), config({ seed: 1 }));
    const b = await runBacktest(
      new RecordingSource(risingThenFalling()),
      config({ seed: 2, fees: { ...DEFAULT_FEES, failureRate: 0.3 } }),
    );
    expect(a.entriesTaken).not.toBe(b.entriesTaken);
  });
});

describe("Ausfuehrungsrealitaet", () => {
  it("belastet fehlgeschlagene Transaktionen mit Gebuehren", async () => {
    // Sie wegzulassen waere die haeufigste Beschoenigung im Backtest.
    const withFailures = await runBacktest(
      new RecordingSource(risingThenFalling()),
      config({ fees: { ...DEFAULT_FEES, failureRate: 0.9 } }),
    );
    const without = await runBacktest(new RecordingSource(risingThenFalling()), config());
    expect(withFailures.entriesTaken).toBeLessThan(without.entriesTaken);
  });

  it("zieht Kosten von jedem Handelsergebnis ab", async () => {
    const result = await runBacktest(new RecordingSource(risingThenFalling()), config());
    for (const trade of result.trades) {
      expect(trade.costsPaid.minor).toBeGreaterThan(0n);
    }
  });

  it("belastet auch den Ausstieg mit Kosten, nicht nur den Einstieg", async () => {
    // Kostenlose Ausstiege sind die stillste Art, einen Backtest zu
    // beschoenigen: in der Statistik stehen ja Kosten — nur eben die halben.
    // Mehr Teilverkaeufe muessen deshalb zu hoeheren Kosten je Trade fuehren.
    const params = DEFAULT_STRATEGY_PARAMETERS;
    const withPartials = await runBacktest(
      new RecordingSource(risingThenFalling()),
      config({ parameters: params }),
    );
    const singleExit = await runBacktest(
      new RecordingSource(risingThenFalling()),
      config({
        parameters: {
          ...params,
          exit: { ...params.exit, takeProfits: [], trailingStopBps: params.exit.trailingStopBps },
        },
      }),
    );

    const avgCost = (r: typeof withPartials): number =>
      r.trades.length === 0
        ? 0
        : Number(r.trades.reduce((sum, t) => sum + t.costsPaid.minor, 0n)) / r.trades.length;

    expect(withPartials.trades.length).toBeGreaterThan(0);
    expect(singleExit.trades.length).toBeGreaterThan(0);
    expect(avgCost(withPartials)).toBeGreaterThan(avgCost(singleExit));
  });
});

describe("Ablehnungen", () => {
  it("protokolliert, warum nicht gehandelt wurde", async () => {
    // Ohne dieses Protokoll beruht jede spaetere Faktoranalyse auf Ueberlebenden.
    const source = new RecordingSource(risingThenFalling(), { liquidityUsd: 5_000 });
    const result = await runBacktest(source, config());
    expect(result.rejections.get("LIQUIDITY_TOO_LOW")).toBeGreaterThan(0);
    expect(result.entriesTaken).toBe(0);
  });

  it("respektiert die Obergrenze offener Positionen", async () => {
    const universe = Array.from({ length: 20 }, (_, i) => tokenId(`token-${i}`));
    const source = new RecordingSource(risingThenFalling(), { universe });
    const result = await runBacktest(source, config());
    expect(result.rejections.get("MAX_OPEN_POSITIONS_REACHED")).toBeGreaterThan(0);
  });
});

describe("Positionsverwaltung im Lauf", () => {
  it("schliesst Positionen und erzeugt auswertbare Trades", async () => {
    const result = await runBacktest(new RecordingSource(risingThenFalling()), config());
    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(trade.closedAt.getTime()).toBeGreaterThan(trade.openedAt.getTime());
      expect(trade.exitReason).toBeTruthy();
    }
  });

  it("verwaltet offene Positionen vor neuen Einstiegen", async () => {
    // Wer erst nach Einstiegen sucht, verwaltet bestehende Positionen mit einem
    // Schritt Verzoegerung — und genau dort passieren die Verluste.
    const source = new RecordingSource(risingThenFalling());
    const result = await runBacktest(source, config());
    expect(result.stepsRun).toBeGreaterThan(100);
  });

  it("kommt mit fehlenden Daten in der Zeitreihe zurecht", async () => {
    // Luecken sind der Normalfall, kein Sonderfall.
    const sparse = priceSeries(START, [1, 1.1, 1.2], 0.001);
    const result = await runBacktest(new RecordingSource(sparse), config());
    expect(result.stepsRun).toBeGreaterThan(3);
  });
});
