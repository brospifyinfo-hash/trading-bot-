import { bps, money, mulDiv, systemClock, type Clock, type Currency, type Money } from "@sae/core";
import { strategyParametersSchema, type StrategyParameters } from "@sae/config";
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
import { and, eq, inArray, sql } from "drizzle-orm";

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
 * Jede ausgeloeste Teilstufe braucht ihren eigenen Quote; ohne Route bleibt sie offen.
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
  /** Explicit cost-model input in the position's currency; missing is not 150 EUR. */
  readonly solPrice?: Money;
  readonly random?: () => number;
  /** Loaded only when a sale is due; no new requests for an empty book or HOLD. */
  readonly loadValuation?: (currency: Currency) => Promise<{
    readonly solPrice: Money;
    readonly valueFill: NonNullable<PositionMonitorDeps["valueFill"]>;
  } | null>;
  /** Value the actual received anchor amount, never the signal's price ratio. */
  readonly valueFill?: (input: { readonly amountRaw: bigint; readonly mint: string; readonly currency: Currency; readonly at: Date }) => Promise<{
    readonly proceeds: Money; readonly observedAt: Date; readonly source: string;
  } | null>;
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


export async function monitorPaperPositions(
  deps: PositionMonitorDeps,
): Promise<PositionMonitorResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const repo = new PaperPositionRepository(deps.db);
  const offen = await repo.openPositions();
  if (offen.length === 0) return { status: "NO_POSITIONS", processed: 0, closed: 0, decisions: {} };

  const versions = await deps.db.select({ id: schema.strategyVersions.id, parameters: schema.strategyVersions.parameters })
    .from(schema.strategyVersions).where(inArray(schema.strategyVersions.id, [...new Set(offen.map((p) => p.strategyVersionId))]));
  const parametersByVersion = new Map(versions.map((v) => [v.id, strategyParametersSchema.safeParse(v.parameters)]));
  const pit = new LivePitReader(deps.db, clock);

  const decisions: Record<string, number> = {};
  const zaehle = (was: string): void => {
    const bisher = decisions[was];
    decisions[was] = bisher === undefined ? 1 : bisher + 1;
  };

  let closed = 0;

  for (const initial of offen) {
    let position = initial;
    const parsed = parametersByVersion.get(position.strategyVersionId);
    if (parsed === undefined || !parsed.success) { zaehle("INVALID_STRATEGY_VERSION"); continue; }
    const parameters = parsed.data;
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

    if (jetzt === null || now.getTime() - jetzt.observedAt.getTime() >= 120_000) {
      zaehle("STALE_PRICE"); continue;
    }
    const events = await deps.db.select({ detail: schema.paperPositionEvents.detail }).from(schema.paperPositionEvents)
      .where(and(eq(schema.paperPositionEvents.positionId, position.id), eq(schema.paperPositionEvents.kind, "PARTIAL_TP")));
    const hitLevels = new Set(events.flatMap((e) => {
      const detail = (e.detail !== null && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
      const level = detail["levelIndex"] ?? detail["level"];
      return typeof level === "number" && Number.isInteger(level) ? [level] : [];
    }));
    const state = stateOf(position, parameters);
    const decision = evaluatePosition({ ...state, takeProfits: state.takeProfits.map((tp) => ({ ...tp, hit: hitLevels.has(tp.index) })) }, market);
    const aktion = decision.actions[0] ?? { kind: "HOLD" as const };
    zaehle(aktion.kind);

    // MAE/MFE bei JEDEM Takt fortschreiben, nicht erst beim Schliessen: der
    // tiefste und der hoechste Punkt liegen dazwischen, und wer sie erst am
    // Ende ausliest, misst nur den Schluss.
    const mfe = Math.max(position.maxFavorableExcursion ?? market.priceRatio, market.priceRatio);
    const mae = Math.min(position.maxAdverseExcursion ?? market.priceRatio, market.priceRatio);

    if (mfe !== position.maxFavorableExcursion || mae !== position.maxAdverseExcursion) {
      const [updated] = await deps.db.update(schema.paperPositions)
        .set({ maxFavorableExcursion: mfe, maxAdverseExcursion: mae, version: sql`${schema.paperPositions.version} + 1` })
        .where(and(eq(schema.paperPositions.id, position.id), eq(schema.paperPositions.version, position.version), sql`${schema.paperPositions.closedAt} is null`)).returning();
      if (updated === undefined) { zaehle("STALE"); continue; }
      position = updated;
    }
    const sells = decision.actions.filter((a) => a.kind === "EXIT_ALL" || a.kind === "SELL_PORTION");
    if (sells.length === 0) continue;
    const pricing = deps.loadValuation === undefined ? deps : await deps.loadValuation(position.currency);
    if (pricing === null || pricing.valueFill === undefined) { zaehle("NO_VALUATION"); continue; }
    if (pricing.solPrice === undefined || pricing.solPrice.currency !== position.currency || pricing.solPrice.minor <= 0n) {
      zaehle("NO_COST_BASIS"); continue;
    }
    const executor = new PaperExecutor({
      clock, quotes: deps.quotes, fees: DEFAULT_FEES, latency: DEFAULT_LATENCY,
      solPrice: pricing.solPrice, dexFeeBps: bps(25), random: deps.random ?? Math.random, driftSample: () => 0,
    });
    for (const action of sells) {
      const requested = action.kind === "EXIT_ALL" ? position.remainingAmountRaw
        : mulDiv(position.entryAmountRaw, BigInt(action.portionBps), 10_000n, "floor");
      const sold = requested < position.remainingAmountRaw ? requested : position.remainingAmountRaw;
      if (sold <= 0n) { zaehle("DUST_PORTION"); continue; }
      const plan: ExecutionPlan = {
        intentId: `exit-${position.id}-${position.version}`,
        side: "sell", inputMint: token.mint as ExecutionPlan["inputMint"],
        outputMint: deps.quoteMint as ExecutionPlan["outputMint"], inAmount: sold,
        notional: notionalOf(position.entryNotionalMinor, sold, position.entryAmountRaw, market.priceRatio, position.currency),
        maxSlippageBps: bps(parameters.risk.maxSlippageBps), plannedAt: now,
      };
      const fill = await executor.execute(plan);
      if (fill.kind !== "FILLED") {
        if (fill.kind === "FAILED") {
          if (fill.costs.total.currency !== position.currency || fill.costs.total.minor < 0n) throw new Error("Invalid failed-exit costs");
          const booked = await repo.applyFill({ positionId: position.id, expectedVersion: position.version,
            soldAmountRaw: 0n, realizedPnlMinorDelta: 0n, costsPaidMinorDelta: fill.costs.total.minor,
            at: fill.failedAt, kind: "EXIT_FAILED", detail: { costsMinor: fill.costs.total.minor.toString(),
              currency: position.currency, reason: fill.reason } });
          if (booked.kind === "STALE") zaehle("STALE_EXIT_FAILURE");
        }
        zaehle(`EXIT_${fill.kind}`); break;
      }
      const valuation = await pricing.valueFill({ amountRaw: fill.outAmount, mint: deps.quoteMint, currency: position.currency, at: fill.filledAt });
      const age = valuation === null ? NaN : fill.filledAt.getTime() - valuation.observedAt.getTime();
      if (valuation === null || !Number.isFinite(age) || age < 0 || age >= 120_000 ||
        valuation.proceeds.currency !== position.currency || valuation.proceeds.minor < 0n || valuation.source.length === 0) {
        zaehle("NO_VALUATION"); break;
      }
      const reason = action.kind === "SELL_PORTION" ? `TAKE_PROFIT_${action.levelIndex}`
        : decision.signals.find((signal) => signal.action.kind === "EXIT_ALL")?.ruleId ?? "EXIT_ALL";
      const settled = await repo.settleSale({
        positionId: position.id, expectedVersion: position.version, soldAmountRaw: sold,
        proceeds: valuation.proceeds, costs: fill.costs.total, at: fill.filledAt,
        reason, levelIndex: action.kind === "SELL_PORTION" ? action.levelIndex : null,
        maxAdverseExcursion: mae, maxFavorableExcursion: mfe,
        valuation: { source: valuation.source, observedAt: valuation.observedAt.toISOString(), amountRaw: fill.outAmount.toString(), mint: deps.quoteMint },
      });
      if (settled.kind === "STALE") { zaehle("STALE"); break; }
      position = settled.position;
      if (position.closedAt !== null) { closed += 1; break; }
    }
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
  if (jetztPreis === null || einstiegPreis === null || !Number.isFinite(jetztPreis) || !Number.isFinite(einstiegPreis) || jetztPreis < 0 || einstiegPreis <= 0) return null;

  const priceRatio = jetztPreis / einstiegPreis;
  if (!Number.isFinite(priceRatio) || !Number.isSafeInteger(Math.round(priceRatio * 1_000_000))) return null;

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
function notionalOf(entry: bigint, sold: bigint, total: bigint, ratio: number, currency: Currency): Money {
  const reference = mulDiv(entry, sold, total, "floor");
  return money(mulDiv(reference, BigInt(Math.round(ratio * 1_000_000)), 1_000_000n, "floor"), currency);
}
