import { bps, eur, systemClock, type Clock, type Money } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS, type StrategyParameters } from "@sae/config";
import { LivePitReader, PaperPositionRepository, schema, type Database } from "@sae/db";
import { tally, type Logger } from "@sae/observability";
import { DEFAULT_FEES, DEFAULT_LATENCY } from "@sae/simulation";
import {
  PaperExecutor,
  evaluatePosition,
  type ExecutionPlan,
  type PositionMarketState,
  type PositionState,
  type QuoteSource,
} from "@sae/trading";
import { eq } from "drizzle-orm";

/**
 * Offene Papier-Positionen ueberwachen.
 *
 * Die letzte Luecke der Bauart „gebaut, nicht verdrahtet": `evaluatePosition`
 * mit allen Ausstiegsregeln lag fertig da, und `MONITOR_PAPER_POSITION` zeigte
 * auf den generischen Marktdaten-Handler. Eine eroeffnete Position waere also
 * nie ueberwacht und nie geschlossen worden — sie haette einfach dagelegen.
 *
 * ### Der Preis kommt aus der Historie, nicht vom Router
 *
 * Zwei Gruende, und der zweite ist der wichtigere:
 *
 * 1. **Kontingent.** Der Router drosselt bei wenigen Anfragen je Sekunde
 *    (DECISIONS §115). Bei jedem Takt fuer jede offene Position zu fragen
 *    waere genau der Stoss, der dort gerade abgestellt wurde.
 * 2. **Vergleichbarkeit.** Der Einstiegspreis stammt aus der Snapshot-Reihe,
 *    der aktuelle muss aus derselben Reihe stammen. Waere der eine vom Router
 *    und der andere aus der Historie, maesse das Verhaeltnis auch den
 *    Unterschied zwischen zwei Anbietern — und ausgerechnet dieses
 *    Verhaeltnis loest Stop Loss und Take Profit aus.
 *
 * Der Router wird trotzdem gefragt, aber nur beim tatsaechlichen VERKAUF: dort
 * geht es um Ausfuehrungskosten, und die kennt nur, wer eine Route rechnet.
 * Verkaeufe sind selten, das Kontingent traegt sie.
 *
 * ### Was der Einstiegspreis hier IST
 *
 * Der Snapshot-Preis zum Eroeffnungszeitpunkt, nicht der gefuellte Preis. Fuer
 * die Ausstiegsregeln ist das richtig: sie fragen „wie weit hat sich der MARKT
 * seit dem Einstieg bewegt", nicht „was habe ich bezahlt". Der gefuellte Preis
 * gehoert in die Gewinnrechnung, und die entsteht beim Verkauf ueber den
 * simulierten Ausfuehrer.
 */

export interface PositionMonitorDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly quotes: QuoteSource;
  readonly clock?: Clock;
  readonly parameters?: StrategyParameters;
  /** Der Anker, gegen den verkauft wird. */
  readonly quoteMint: string;
}

export interface PositionMonitorResult {
  readonly status: "OK" | "NO_POSITIONS";
  readonly processed: number;
  readonly closed: number;
  /** Was entschieden wurde — HOLD, SELL_PORTION, EXIT_ALL, oder warum nichts. */
  readonly decisions: Readonly<Record<string, number>>;
}

/** Portfoliowaehrung der Simulation. Dieselbe Annahme wie im Entscheidungslauf. */
const CURRENCY = "EUR" as const;

export async function monitorPaperPositions(
  deps: PositionMonitorDeps,
): Promise<PositionMonitorResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const repo = new PaperPositionRepository(deps.db);
  const offen = await repo.openPositions();
  if (offen.length === 0) return { status: "NO_POSITIONS", processed: 0, closed: 0, decisions: {} };

  const parameters = deps.parameters ?? DEFAULT_STRATEGY_PARAMETERS;
  const pit = new LivePitReader(deps.db, clock);
  const executor = new PaperExecutor({
    clock,
    quotes: deps.quotes,
    fees: DEFAULT_FEES,
    latency: DEFAULT_LATENCY,
    solPrice: eur(150),
    dexFeeBps: bps(25),
    random: Math.random,
    driftSample: () => 0,
  });

  const decisions: Record<string, number> = {};
  const zaehle = (was: string): void => {
    const bisher = decisions[was];
    decisions[was] = bisher === undefined ? 1 : bisher + 1;
  };

  let closed = 0;

  for (const position of offen) {
    const [token] = await deps.db
      .select({ mint: schema.tokens.mint })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, position.tokenId))
      .limit(1);
    if (token === undefined) {
      zaehle("NO_TOKEN");
      continue;
    }

    const [jetzt, beiEinstieg] = await Promise.all([
      pit.snapshotAt(position.tokenId, now),
      pit.snapshotAt(position.tokenId, position.openedAt),
    ]);

    const market = marketStateOf({
      jetztPreis: jetzt?.priceUsd ?? null,
      einstiegPreis: beiEinstieg?.priceUsd ?? null,
      jetztLiquiditaet: jetzt?.liquidityUsd ?? null,
      einstiegLiquiditaet: beiEinstieg?.liquidityUsd ?? null,
      buys: jetzt?.buys5m ?? null,
      sells: jetzt?.sells5m ?? null,
      hoechstesVerhaeltnis: position.maxFavorableExcursion,
      haltedauerSekunden: Math.max(0, Math.round((now.getTime() - position.openedAt.getTime()) / 1_000)),
    });

    if (market === null) {
      // Ohne beide Preise gibt es kein Verhaeltnis — und ein geschaetztes
      // waere hier besonders teuer: es loest Stop Loss und Take Profit aus.
      zaehle("NO_PRICE");
      continue;
    }

    const decision = evaluatePosition(stateOf(position, parameters), market);
    const aktion = decision.actions[0] ?? { kind: "HOLD" as const };
    zaehle(aktion.kind);

    // MAE/MFE bei JEDEM Takt fortschreiben, nicht erst beim Schliessen: der
    // tiefste und der hoechste Punkt liegen dazwischen, und wer sie erst am
    // Ende ausliest, misst nur den Schluss.
    const mfe = Math.max(position.maxFavorableExcursion ?? market.priceRatio, market.priceRatio);
    const mae = Math.min(position.maxAdverseExcursion ?? market.priceRatio, market.priceRatio);

    if (aktion.kind !== "EXIT_ALL") {
      if (mfe !== position.maxFavorableExcursion || mae !== position.maxAdverseExcursion) {
        await deps.db
          .update(schema.paperPositions)
          .set({ maxFavorableExcursion: mfe, maxAdverseExcursion: mae })
          .where(eq(schema.paperPositions.id, position.id));
      }
      continue;
    }

    // Erst hier wird der Router gefragt: es geht um Ausfuehrungskosten, und
    // die kennt nur, wer eine Route rechnet.
    const plan: ExecutionPlan = {
      intentId: `exit-${position.id}`,
      side: "sell",
      inputMint: token.mint as ExecutionPlan["inputMint"],
      outputMint: deps.quoteMint as ExecutionPlan["outputMint"],
      inAmount: position.remainingAmountRaw,
      notional: notionalOf(position.entryNotionalMinor, market.priceRatio),
      maxSlippageBps: bps(parameters.risk.maxSlippageBps),
      plannedAt: now,
    };
    const fill = await executor.execute(plan);
    if (fill.kind !== "FILLED") {
      // Kein Fill, keine Schliessung. Eine Position ohne Ausstiegspreis zu
      // schliessen hiesse, den Gewinn zu erfinden.
      zaehle(`EXIT_${fill.kind}`);
      continue;
    }

    const result = await repo.close({
      positionId: position.id,
      expectedVersion: position.version,
      closedAt: now,
      exitReason: decision.signals[0]?.ruleId ?? "EXIT_ALL",
      maxAdverseExcursion: mae,
      maxFavorableExcursion: mfe,
      // Wie viel des erreichbaren Hochs tatsaechlich realisiert wurde.
      exitEfficiency: mfe > 1 ? (market.priceRatio - 1) / (mfe - 1) : null,
    });
    if (result.kind === "CLOSED") closed += 1;
    else zaehle("STALE");
  }

  deps.logger.info(
    { role: "position-monitor", processed: offen.length, closed, decisions: tally(decisions) },
    "Papier-Positionen geprueft",
  );

  return { status: "OK", processed: offen.length, closed, decisions };
}

/** Der Zustand der Position, wie ihn die Ausstiegsregeln erwarten. */
function stateOf(
  position: typeof schema.paperPositions.$inferSelect,
  parameters: StrategyParameters,
): PositionState {
  const entry = position.entryAmountRaw;
  // Verbleibender Anteil in Basispunkten. Ganzzahlig gerechnet, weil
  // Token-Mengen jenseits von Number.MAX_SAFE_INTEGER liegen koennen.
  const remainingBps =
    entry <= 0n ? 0 : Number((position.remainingAmountRaw * 10_000n) / entry);

  return {
    positionId: position.id,
    remainingBps: bps(Math.max(0, Math.min(10_000, remainingBps))),
    stopLossBps: bps(parameters.exit.stopLossBps),
    // `null` heisst „kein Trailing Stop" und ist ein gueltiger Zustand. Eine
    // 0 daraus zu machen waere ein Stop bei jedem Rueckgang.
    trailingStopBps:
      parameters.exit.trailingStopBps === null ? null : bps(parameters.exit.trailingStopBps),
    takeProfits: parameters.exit.takeProfits.map((tp) => ({
      index: tp.index,
      triggerGainBps: bps(tp.triggerGainBps),
      sellPortionBps: bps(tp.sellPortionBps),
      // Ohne Ereignishistorie gilt keine Stufe als erreicht. Das ist die
      // vorsichtige Vorgabe: eine faelschlich als erreicht gefuehrte Stufe
      // wuerde nie wieder ausloesen.
      hit: false,
    })),
    // `null` heisst „keine Zeitgrenze". Die Regel behandelt es so; eine Zahl
    // daraus zu machen waere eine Haltedauer, die niemand festgelegt hat.
    maxHoldingSeconds: parameters.exit.maxHoldingTimeSeconds ?? null,
  };
}

/**
 * Der Marktzustand — oder `null`, wenn das Verhaeltnis nicht bildbar ist.
 *
 * Beide Preise muessen aus derselben Reihe stammen. Fehlt einer, gibt es kein
 * Verhaeltnis; einen zu schaetzen hiesse, Stop Loss und Take Profit auf eine
 * erfundene Zahl zu stellen.
 */
function marketStateOf(input: {
  readonly jetztPreis: number | null;
  readonly einstiegPreis: number | null;
  readonly jetztLiquiditaet: number | null;
  readonly einstiegLiquiditaet: number | null;
  readonly buys: number | null;
  readonly sells: number | null;
  readonly hoechstesVerhaeltnis: number | null;
  readonly haltedauerSekunden: number;
}): PositionMarketState | null {
  const { jetztPreis, einstiegPreis } = input;
  if (jetztPreis === null || einstiegPreis === null || einstiegPreis <= 0) return null;

  const priceRatio = jetztPreis / einstiegPreis;

  // Der Kaufanteil nur, wenn BEIDE Zahlen da sind. Ein fehlender Wert als 0
  // gelesen machte aus „unbekannt" ein „niemand hat verkauft" — und der
  // Unterschied entscheidet mit ueber den Ausstieg.
  const { buys, sells } = input;
  const buyRatio =
    buys === null || sells === null || buys + sells === 0 ? null : buys / (buys + sells);

  return {
    priceRatio,
    // Der hoechste bisher erreichte Stand. Beim ersten Takt ist das der
    // jetzige — nicht 1, denn dann waere jeder Gewinn sofort ein Rueckgang
    // vom Hoch.
    highWaterRatio: Math.max(input.hoechstesVerhaeltnis ?? priceRatio, priceRatio),
    // Nicht erhoben: der Snapshot fuehrt kein Fuenf-Minuten-Volumen je
    // Position. `null` heisst unbekannt, und die Regeln behandeln es so.
    volumeAcceleration: null,
    buyRatio,
    liquidityRatio:
      input.jetztLiquiditaet === null ||
      input.einstiegLiquiditaet === null ||
      input.einstiegLiquiditaet <= 0
        ? null
        : input.jetztLiquiditaet / input.einstiegLiquiditaet,
    smartMoneySellers: null,
    devSold: null,
    // Kein Sicherheitsvergleich ueber die Zeit: dafuer muessten zwei Befunde
    // verglichen werden, und das ist eine eigene Arbeit.
    securityDowngraded: false,
    holdingSeconds: input.haltedauerSekunden,
  };
}

/** Der aktuelle Gegenwert der Position, fuer die Kostenrechnung des Ausstiegs. */
function notionalOf(entryNotionalMinor: bigint, priceRatio: number): Money {
  const minor = BigInt(Math.max(0, Math.round(Number(entryNotionalMinor) * priceRatio)));
  return { minor, currency: CURRENCY } as Money;
}
