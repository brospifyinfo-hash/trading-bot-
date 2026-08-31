/**
 * Marktregime — als Mechanik, noch ohne kalibrierte Labels.
 *
 * §18 will, dass Entscheidungen den Marktzustand kennen. Das grosse Risiko
 * dabei ist nicht die Klassifikation selbst, sondern wie sie entsteht (I-3):
 *
 * **Ein rueckwirkend vergebenes Regime-Label ist Look-Ahead, der wie eine
 * Erkenntnis aussieht.** Wer im Nachhinein sagt „das war eine Risk-Off-Phase"
 * und die Trades dieser Phase danach auswertet, hat den Ausgang benutzt, um die
 * Bedingung zu definieren. Das Ergebnis ist zwangslaeufig gut und vollstaendig
 * wertlos.
 *
 * Deshalb drei Festlegungen, die vor jeder inhaltlichen Kalibrierung stehen:
 *
 * 1. Das Regime wird zum Beobachtungszeitpunkt bestimmt, aus Daten, die zu
 *    diesem Zeitpunkt vorlagen. `RegimeTimeline` nimmt keinen Eintrag an, der
 *    aelter ist als der letzte — Backfill scheitert am Datentyp, nicht an der
 *    Absicht.
 * 2. `UNKNOWN` ist ein vollwertiges Regime, kein Platzhalter. Es ist der
 *    haeufigste Zustand, solange kein Provider laeuft.
 * 3. Ein Regime wechselt nicht bei einer einzelnen Messung. Ohne Hysterese
 *    flattert das Label, und jede spaetere Auswertung nach Regime mischt
 *    Phasen, die nur durch Rauschen getrennt sind.
 *
 * Die Schwellen unten sind **Startwerte, keine Messungen**. Welche Werte einen
 * Marktzustand tatsaechlich trennen, laesst sich erst sagen, wenn genug
 * beobachtete Zeitreihen vorliegen — bis dahin ist jede Zahl hier eine Annahme.
 */

export type MarketRegime = "RISK_ON" | "NEUTRAL" | "RISK_OFF" | "UNKNOWN";

export type RegimeIndicator = "BREADTH" | "MEDIAN_RETURN" | "NEW_LISTING_RATE" | "STOP_RATE";

/**
 * Eingaben, die das System aus eigenen Daten bilden kann.
 *
 * Bewusst keine externen Marktindizes: die gaebe es nur ueber einen Provider,
 * und ein erfundener Endpoint waere schlimmer als ein fehlendes Regime.
 */
export interface RegimeInputs {
  /** Anteil beobachteter Tokens im Plus ueber das Fenster, 0..1. */
  readonly breadth: number | null;
  /** Medianrendite der beobachteten Tokens ueber das Fenster, als Anteil. */
  readonly medianReturn: number | null;
  /** Neue Listings relativ zum eigenen Mittel der Vorwochen, 1 = normal. */
  readonly newListingRate: number | null;
  /** Anteil eigener Positionen im Fenster, die in den Stop gelaufen sind. */
  readonly stopRate: number | null;
}

export interface RegimeThresholds {
  readonly breadthRiskOn: number;
  readonly breadthRiskOff: number;
  readonly medianReturnRiskOn: number;
  readonly medianReturnRiskOff: number;
  readonly newListingRateRiskOn: number;
  readonly newListingRateRiskOff: number;
  readonly stopRateRiskOff: number;
  readonly stopRateRiskOn: number;
  /** Wie viele Indikatoren mindestens vorliegen muessen. Darunter: UNKNOWN. */
  readonly minIndicators: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  breadthRiskOn: 0.6,
  breadthRiskOff: 0.35,
  medianReturnRiskOn: 0.05,
  medianReturnRiskOff: -0.05,
  newListingRateRiskOn: 1.3,
  newListingRateRiskOff: 0.7,
  stopRateRiskOff: 0.6,
  stopRateRiskOn: 0.3,
  minIndicators: 3,
};

export type IndicatorVote = "RISK_ON" | "NEUTRAL" | "RISK_OFF";

export interface RegimeAssessment {
  readonly regime: MarketRegime;
  readonly votes: Readonly<Partial<Record<RegimeIndicator, IndicatorVote>>>;
  readonly available: readonly RegimeIndicator[];
  readonly missing: readonly RegimeIndicator[];
  readonly note: string;
}

function vote(
  value: number | null,
  riskOnAt: number,
  riskOffAt: number,
): IndicatorVote | null {
  if (value === null) return null;
  const risingIsRiskOn = riskOnAt > riskOffAt;
  if (risingIsRiskOn) {
    if (value >= riskOnAt) return "RISK_ON";
    if (value <= riskOffAt) return "RISK_OFF";
  } else {
    if (value <= riskOnAt) return "RISK_ON";
    if (value >= riskOffAt) return "RISK_OFF";
  }
  return "NEUTRAL";
}

/**
 * Momentaufnahme. Kennt keine Historie und kann deshalb auch keine
 * ueberschreiben.
 */
export function assessRegime(
  input: RegimeInputs,
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): RegimeAssessment {
  const votes: Partial<Record<RegimeIndicator, IndicatorVote>> = {};
  const available: RegimeIndicator[] = [];
  const missing: RegimeIndicator[] = [];

  const put = (indicator: RegimeIndicator, v: IndicatorVote | null): void => {
    if (v === null) missing.push(indicator);
    else {
      votes[indicator] = v;
      available.push(indicator);
    }
  };

  put("BREADTH", vote(input.breadth, thresholds.breadthRiskOn, thresholds.breadthRiskOff));
  put(
    "MEDIAN_RETURN",
    vote(input.medianReturn, thresholds.medianReturnRiskOn, thresholds.medianReturnRiskOff),
  );
  put(
    "NEW_LISTING_RATE",
    vote(input.newListingRate, thresholds.newListingRateRiskOn, thresholds.newListingRateRiskOff),
  );
  // Eine hohe Stop-Quote spricht fuer Risk-Off — die Richtung ist hier umgekehrt.
  put("STOP_RATE", vote(input.stopRate, thresholds.stopRateRiskOn, thresholds.stopRateRiskOff));

  if (available.length < thresholds.minIndicators) {
    return {
      regime: "UNKNOWN",
      votes,
      available,
      missing,
      note: `${available.length} von ${thresholds.minIndicators} noetigen Indikatoren vorhanden.`,
    };
  }

  const counts = { RISK_ON: 0, NEUTRAL: 0, RISK_OFF: 0 };
  for (const indicator of available) counts[votes[indicator]!] += 1;

  // Mehrheit der VORHANDENEN Indikatoren, und bei Gleichstand NEUTRAL. Ein
  // Stichentscheid waere eine Gewichtung, die man spaeter passend machen kann.
  const majority = Math.floor(available.length / 2) + 1;
  const regime: MarketRegime =
    counts.RISK_ON >= majority ? "RISK_ON" : counts.RISK_OFF >= majority ? "RISK_OFF" : "NEUTRAL";

  return {
    regime,
    votes,
    available,
    missing,
    note: `${counts.RISK_ON} risk-on, ${counts.NEUTRAL} neutral, ${counts.RISK_OFF} risk-off.`,
  };
}

export interface RegimeEntry {
  readonly regime: MarketRegime;
  readonly observedAt: Date;
  readonly assessment: RegimeAssessment;
}

export interface HysteresisSettings {
  /** Wie viele aufeinanderfolgende abweichende Messungen einen Wechsel tragen. */
  readonly confirmationsToSwitch: number;
  /** Mindestverweildauer, bevor ueberhaupt gewechselt werden darf. */
  readonly minDwellSeconds: number;
}

export const DEFAULT_HYSTERESIS: HysteresisSettings = {
  confirmationsToSwitch: 3,
  minDwellSeconds: 900,
};

export class BackfillRejectedError extends Error {
  constructor(attemptedAt: Date, lastAt: Date) {
    super(
      `Regime-Eintrag fuer ${attemptedAt.toISOString()} liegt vor dem letzten ` +
        `(${lastAt.toISOString()}) — rueckwirkende Labels sind Look-Ahead.`,
    );
    this.name = "BackfillRejectedError";
  }
}

/**
 * Verlauf der Regime, append-only.
 *
 * Das ist die technische Fassung von I-3. Ein Eintrag mit einem Zeitstempel vor
 * dem letzten wird abgewiesen, und es gibt keine Methode, die einen bestehenden
 * Eintrag aendert. Wer ein Regime nachtraegt, muss dafuer eine neue Klasse
 * schreiben — und das faellt in einer Codeaenderung auf.
 */
export class RegimeTimeline {
  readonly #entries: RegimeEntry[] = [];
  readonly #hysteresis: HysteresisSettings;
  /** Wie oft in Folge etwas anderes gemessen wurde als das geltende Regime. */
  #pendingRegime: MarketRegime | null = null;
  #pendingCount = 0;

  constructor(hysteresis: HysteresisSettings = DEFAULT_HYSTERESIS) {
    this.#hysteresis = hysteresis;
  }

  get entries(): readonly RegimeEntry[] {
    return this.#entries;
  }

  current(): RegimeEntry | null {
    return this.#entries[this.#entries.length - 1] ?? null;
  }

  /**
   * Nimmt eine Messung auf und gibt das GELTENDE Regime zurueck.
   *
   * Die Messung ist nicht das Regime: erst nach genug Bestaetigungen und nach
   * Ablauf der Mindestverweildauer wird gewechselt. Bis dahin bleibt das alte
   * gueltig — auch wenn die aktuelle Messung etwas anderes sagt.
   */
  observe(assessment: RegimeAssessment, observedAt: Date): MarketRegime {
    const last = this.current();
    if (last !== null && observedAt.getTime() < last.observedAt.getTime()) {
      throw new BackfillRejectedError(observedAt, last.observedAt);
    }

    if (last === null) {
      this.#entries.push({ regime: assessment.regime, observedAt, assessment });
      this.#pendingRegime = null;
      this.#pendingCount = 0;
      return assessment.regime;
    }

    if (assessment.regime === last.regime) {
      this.#pendingRegime = null;
      this.#pendingCount = 0;
      return last.regime;
    }

    this.#pendingCount = assessment.regime === this.#pendingRegime ? this.#pendingCount + 1 : 1;
    this.#pendingRegime = assessment.regime;

    const dwelledSeconds = (observedAt.getTime() - last.observedAt.getTime()) / 1_000;
    const confirmed = this.#pendingCount >= this.#hysteresis.confirmationsToSwitch;
    const settled = dwelledSeconds >= this.#hysteresis.minDwellSeconds;

    if (confirmed && settled) {
      this.#entries.push({ regime: assessment.regime, observedAt, assessment });
      this.#pendingRegime = null;
      this.#pendingCount = 0;
      return assessment.regime;
    }

    return last.regime;
  }

  /**
   * Welches Regime zu einem Zeitpunkt GALT.
   *
   * Nur fuer Zeitpunkte, die nicht in der Zukunft des Verlaufs liegen — und
   * ohne Interpolation. Vor dem ersten Eintrag ist die Antwort `UNKNOWN`, nicht
   * das erste bekannte Regime: rueckwaerts extrapoliert waere genau der
   * Look-Ahead, den I-3 meint.
   */
  regimeAt(at: Date): MarketRegime {
    let result: MarketRegime = "UNKNOWN";
    for (const entry of this.#entries) {
      if (entry.observedAt.getTime() <= at.getTime()) result = entry.regime;
      else break;
    }
    return result;
  }
}
