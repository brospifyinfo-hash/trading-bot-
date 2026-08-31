import { money, mulDiv, type Money, type TradingStream } from "@sae/core";

/**
 * Exposure je Strom und je Korrelationsgruppe.
 *
 * Zwei getrennte Probleme, die beide unter „Portfolio-Limit" laufen:
 *
 * **1. Stroeme duerfen sich nicht gegenseitig blockieren (I-10).** Auto Paper,
 * Manual Paper und Live halten oft denselben Token. Zaehlt man das zusammen,
 * blockiert ein voll investiertes Paper-Portfolio den Live-Handel — obwohl dort
 * kein einziger Euro liegt. Zaehlt man es gar nicht, ist die Konzentration
 * innerhalb eines Stroms unsichtbar. Also: getrennte Buecher, kein Gesamtwert.
 * Es gibt hier bewusst keine Funktion, die ueber Stroeme summiert.
 *
 * **2. Zehn Positionen koennen eine sein (§51).** Zehn Tokens desselben
 * Narrativs, desselben Deployers oder derselben Liquiditaetsquelle fallen
 * gemeinsam. Zehn Positionen zu je 3 % sind dann keine 30 % gestreutes Risiko,
 * sondern eine Position von 30 %.
 *
 * Der wichtigste Punkt daran ist die Behandlung des Unbekannten: eine Position
 * ohne bekannte Gruppe wird NICHT als unkorreliert behandelt. Sie kommt in
 * einen gemeinsamen Topf mit allen anderen unbekannten. Andernfalls waere
 * fehlende Information die bequemste Art, jedes Konzentrationslimit zu
 * umgehen — und zwar genau, solange die Clustering-Daten fehlen.
 */

/** Gruppe fuer Positionen ohne bekannte Zuordnung. */
export const UNKNOWN_CORRELATION_GROUP = "UNKNOWN";

export interface CorrelatedPosition {
  readonly tokenId: string;
  readonly notional: Money;
  /**
   * Korrelationsgruppe, etwa Deployer, Narrativ oder Liquiditaetscluster.
   * `null` heisst unbekannt — und wird konservativ zusammengefasst.
   */
  readonly correlationGroup: string | null;
}

export interface StreamExposureState {
  readonly stream: TradingStream;
  /** Bezugsgroesse dieses Stroms. Bei Paper das simulierte Kapital. */
  readonly value: Money;
  readonly positions: readonly CorrelatedPosition[];
}

export interface CorrelationLimits {
  readonly maxPortfolioExposurePct: number;
  readonly maxOpenPositions: number;
  /** Hoechster Anteil, den eine Korrelationsgruppe ausmachen darf. */
  readonly maxGroupExposurePct: number;
  readonly maxPositionsPerGroup: number;
}

export const DEFAULT_CORRELATION_LIMITS: CorrelationLimits = {
  maxPortfolioExposurePct: 15,
  maxOpenPositions: 5,
  maxGroupExposurePct: 8,
  maxPositionsPerGroup: 2,
};

export type ExposureViolation =
  | "PORTFOLIO_EXPOSURE_LIMIT"
  | "MAX_OPEN_POSITIONS_REACHED"
  | "CORRELATION_GROUP_EXPOSURE_LIMIT"
  | "CORRELATION_GROUP_POSITION_LIMIT"
  | "TOKEN_ALREADY_HELD_IN_STREAM";

export interface GroupExposure {
  readonly group: string;
  readonly exposure: Money;
  readonly exposurePct: number;
  readonly positionCount: number;
  /** Ob diese Gruppe nur „unbekannt" bedeutet. */
  readonly isUnknownBucket: boolean;
}

export interface StreamExposureCheck {
  readonly stream: TradingStream;
  readonly exposureAfterTrade: Money;
  readonly exposurePctAfterTrade: number;
  readonly groups: readonly GroupExposure[];
  readonly withinLimits: boolean;
  readonly violations: readonly ExposureViolation[];
}

function pctOf(part: bigint, whole: Money): number {
  if (whole.minor === 0n) return Number.POSITIVE_INFINITY;
  return Number(mulDiv(part, 1_000_000n, whole.minor, "floor")) / 10_000;
}

const groupKey = (p: CorrelatedPosition): string =>
  p.correlationGroup ?? UNKNOWN_CORRELATION_GROUP;

/**
 * Prueft einen geplanten Trade GEGEN EINEN STROM.
 *
 * Der Strom ist Pflichtparameter und kommt aus dem Zustand — es gibt keine
 * Variante, die „ueber alle" prueft.
 */
export function checkStreamExposure(
  state: StreamExposureState,
  planned: CorrelatedPosition,
  limits: CorrelationLimits = DEFAULT_CORRELATION_LIMITS,
): StreamExposureCheck {
  const currency = state.value.currency;
  for (const p of state.positions) {
    if (p.notional.currency !== currency) {
      throw new TypeError(`Position ${p.tokenId} in anderer Waehrung als der Strom`);
    }
  }
  if (planned.notional.currency !== currency) {
    throw new TypeError("Geplante Position in anderer Waehrung als der Strom");
  }

  const all = [...state.positions, planned];
  const totalMinor = all.reduce((sum, p) => sum + p.notional.minor, 0n);

  const byGroup = new Map<string, CorrelatedPosition[]>();
  for (const p of all) {
    const key = groupKey(p);
    const bucket = byGroup.get(key);
    if (bucket === undefined) byGroup.set(key, [p]);
    else bucket.push(p);
  }

  const groups: GroupExposure[] = [...byGroup.entries()]
    .map(([group, members]) => {
      const exposureMinor = members.reduce((sum, p) => sum + p.notional.minor, 0n);
      return {
        group,
        exposure: money(exposureMinor, currency),
        exposurePct: pctOf(exposureMinor, state.value),
        positionCount: members.length,
        isUnknownBucket: group === UNKNOWN_CORRELATION_GROUP,
      };
    })
    .sort((a, b) => (a.exposure.minor > b.exposure.minor ? -1 : 1));

  const violations: ExposureViolation[] = [];
  const exposurePctAfterTrade = pctOf(totalMinor, state.value);

  if (exposurePctAfterTrade > limits.maxPortfolioExposurePct) {
    violations.push("PORTFOLIO_EXPOSURE_LIMIT");
  }
  if (state.positions.length >= limits.maxOpenPositions) {
    violations.push("MAX_OPEN_POSITIONS_REACHED");
  }
  if (state.positions.some((p) => p.tokenId === planned.tokenId)) {
    violations.push("TOKEN_ALREADY_HELD_IN_STREAM");
  }

  const plannedGroup = groups.find((g) => g.group === groupKey(planned));
  if (plannedGroup !== undefined) {
    if (plannedGroup.exposurePct > limits.maxGroupExposurePct) {
      violations.push("CORRELATION_GROUP_EXPOSURE_LIMIT");
    }
    if (plannedGroup.positionCount > limits.maxPositionsPerGroup) {
      violations.push("CORRELATION_GROUP_POSITION_LIMIT");
    }
  }

  return {
    stream: state.stream,
    exposureAfterTrade: money(totalMinor, currency),
    exposurePctAfterTrade,
    groups,
    withinLimits: violations.length === 0,
    violations,
  };
}

/**
 * Die Buecher aller Stroeme nebeneinander.
 *
 * Absichtlich ohne Gesamtsumme: eine solche Zahl waere sofort in einem Gate
 * gelandet, und dann blockierte simuliertes Kapital echte Trades.
 */
export class StreamExposureBook {
  readonly #states = new Map<TradingStream, StreamExposureState>();

  set(state: StreamExposureState): void {
    this.#states.set(state.stream, state);
  }

  get(stream: TradingStream): StreamExposureState | null {
    return this.#states.get(stream) ?? null;
  }

  /**
   * Prueft ausschliesslich gegen das Buch des angegebenen Stroms.
   *
   * Ist der Strom unbekannt, gibt es kein Ergebnis — und ausdruecklich kein
   * „dann eben erlaubt".
   */
  check(
    stream: TradingStream,
    planned: CorrelatedPosition,
    limits: CorrelationLimits = DEFAULT_CORRELATION_LIMITS,
  ): StreamExposureCheck | null {
    const state = this.#states.get(stream);
    if (state === undefined) return null;
    return checkStreamExposure(state, planned, limits);
  }

  streams(): readonly TradingStream[] {
    return [...this.#states.keys()];
  }
}
