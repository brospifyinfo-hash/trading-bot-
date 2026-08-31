import { score, type Reason, type Score } from "@sae/core";

import { rampDown, rampUp } from "./sub-score";

/**
 * Datenqualitaet als eigener Score — nicht als Teil des Handelsscores.
 *
 * Es gibt bereits `dataCompleteness`: den Anteil vorhandener Felder. §22 will
 * mehr, und die Ergaenzungen sind genau die Faelle, in denen Vollstaendigkeit
 * luegt:
 *
 * - **Alter** — alle Felder da, aber vier Minuten alt. Bei einem Memecoin ist
 *   das eine andere Welt.
 * - **Widersprueche** — zwei Provider melden verschiedene Preise. Vollstaendig
 *   ist beides.
 * - **Ausfaelle** — der wichtigste Provider war weg, ein zweitrangiger hat
 *   eingesprungen. Der Feldbestand sieht unveraendert aus.
 * - **Latenz** — zwischen Beobachtung und Entscheidung lagen Sekunden.
 *
 * Der Score fliesst NICHT in den Handelsscore ein. Er steht daneben und gatet:
 * ein schlechter Token mit guten Daten bleibt ein schlechter Token, aber ein
 * guter Token mit schlechten Daten ist keine Gelegenheit, sondern eine
 * Vermutung. Verrechnet man beides, ist hinterher nicht mehr erkennbar, welche
 * der beiden Groessen die Entscheidung getragen hat.
 */

export interface DataQualityInputs {
  /** Anteil vorhandener Felder, 0..1. Der bestehende Eingang. */
  readonly completeness: number;
  /** Alter der aeltesten verwendeten Beobachtung in Sekunden. */
  readonly oldestObservationAgeSeconds: number | null;
  /** Zeit zwischen juengster Beobachtung und Entscheidung. */
  readonly decisionLatencyMs: number | null;
  /**
   * Anzahl erkannter Widersprueche zwischen Quellen.
   * `null` = es wurde nicht darauf geprueft — das ist NICHT null Widersprueche.
   */
  readonly contradictionCount: number | null;
  /** Provider, die zum Entscheidungszeitpunkt gestoert oder ausgefallen waren. */
  readonly degradedProviders: number | null;
  /** Wie viele Provider fuer diese Entscheidung ueberhaupt gebraucht wurden. */
  readonly requiredProviders: number;
}

export interface DataQualityThresholds {
  /** Ab diesem Alter faellt die Frische auf 0. */
  readonly maxAcceptableAgeSeconds: number;
  /** Ab dieser Latenz faellt der Latenzteil auf 0. */
  readonly maxAcceptableLatencyMs: number;
  /** Ab so vielen Widerspruechen faellt die Konsistenz auf 0. */
  readonly contradictionsAtZero: number;
}

/**
 * Startwerte, ausdruecklich als Annahmen.
 *
 * Keiner ist gemessen. 30 Sekunden Alter und 2 Sekunden Latenz sind aus dem
 * Verhalten eines frisch gelisteten Tokens geschaetzt, nicht kalibriert — sobald
 * echte Beobachtungen vorliegen, gehoeren sie ueberprueft.
 */
export const DEFAULT_DATA_QUALITY_THRESHOLDS: DataQualityThresholds = {
  maxAcceptableAgeSeconds: 30,
  maxAcceptableLatencyMs: 2_000,
  contradictionsAtZero: 3,
};

export type DataQualityDimension =
  | "COMPLETENESS"
  | "FRESHNESS"
  | "LATENCY"
  | "CONSISTENCY"
  | "PROVIDER_HEALTH";

export interface DataQualityResult {
  /** Mittel ueber die BEURTEILBAREN Dimensionen. */
  readonly score: Score;
  readonly assessed: readonly DataQualityDimension[];
  /**
   * Dimensionen, zu denen nichts vorlag.
   *
   * Sie gehen NICHT als „gut" in den Score ein und werden auch nicht als
   * „schlecht" gewertet — beides waere erfunden. Stattdessen stehen sie hier,
   * und das Gate verlangt eine Mindestzahl beurteilter Dimensionen. „Wir haben
   * nicht auf Widersprueche geprueft" darf nicht zu „keine Widersprueche"
   * werden.
   */
  readonly unassessed: readonly DataQualityDimension[];
  readonly drivers: readonly Reason[];
  readonly perDimension: Readonly<Partial<Record<DataQualityDimension, number>>>;
}

function reasonOf(code: string, detail: string): Reason {
  return { code, detail };
}

export function computeDataQuality(
  input: DataQualityInputs,
  thresholds: DataQualityThresholds = DEFAULT_DATA_QUALITY_THRESHOLDS,
): DataQualityResult {
  const perDimension: Partial<Record<DataQualityDimension, number>> = {};
  const assessed: DataQualityDimension[] = [];
  const unassessed: DataQualityDimension[] = [];
  const drivers: Reason[] = [];

  const completeness = Math.max(0, Math.min(1, input.completeness)) * 100;
  perDimension.COMPLETENESS = completeness;
  assessed.push("COMPLETENESS");
  if (completeness < 100) {
    drivers.push(
      reasonOf("INCOMPLETE_INPUTS", `${completeness.toFixed(0)} % der Felder vorhanden`),
    );
  }

  if (input.oldestObservationAgeSeconds === null) {
    unassessed.push("FRESHNESS");
  } else {
    const freshness = rampDown(
      input.oldestObservationAgeSeconds,
      0,
      thresholds.maxAcceptableAgeSeconds,
    );
    perDimension.FRESHNESS = freshness;
    assessed.push("FRESHNESS");
    if (freshness < 50) {
      drivers.push(
        reasonOf(
          "STALE_DATA",
          `aelteste Beobachtung ${input.oldestObservationAgeSeconds.toFixed(0)} s alt`,
        ),
      );
    }
  }

  if (input.decisionLatencyMs === null) {
    unassessed.push("LATENCY");
  } else {
    const latency = rampDown(input.decisionLatencyMs, 0, thresholds.maxAcceptableLatencyMs);
    perDimension.LATENCY = latency;
    assessed.push("LATENCY");
    if (latency < 50) {
      drivers.push(
        reasonOf("SLOW_DECISION", `${input.decisionLatencyMs.toFixed(0)} ms bis zur Entscheidung`),
      );
    }
  }

  if (input.contradictionCount === null) {
    unassessed.push("CONSISTENCY");
    drivers.push(
      reasonOf("CONSISTENCY_UNCHECKED", "nicht auf Widersprueche zwischen Quellen geprueft"),
    );
  } else {
    const consistency = rampDown(input.contradictionCount, 0, thresholds.contradictionsAtZero);
    perDimension.CONSISTENCY = consistency;
    assessed.push("CONSISTENCY");
    if (input.contradictionCount > 0) {
      drivers.push(
        reasonOf("SOURCES_DISAGREE", `${input.contradictionCount} Widerspruch/Widersprueche`),
      );
    }
  }

  if (input.degradedProviders === null || input.requiredProviders <= 0) {
    unassessed.push("PROVIDER_HEALTH");
  } else {
    const healthy = Math.max(0, input.requiredProviders - input.degradedProviders);
    const health = rampUp(healthy / input.requiredProviders, 0, 1);
    perDimension.PROVIDER_HEALTH = health;
    assessed.push("PROVIDER_HEALTH");
    if (input.degradedProviders > 0) {
      drivers.push(
        reasonOf(
          "PROVIDER_DEGRADED",
          `${input.degradedProviders} von ${input.requiredProviders} Providern gestoert`,
        ),
      );
    }
  }

  const values = assessed.map((d) => perDimension[d] ?? 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  return {
    score: score(mean),
    assessed,
    unassessed,
    drivers,
    perDimension,
  };
}

export interface DataQualityGate {
  readonly minScore: number;
  /** Wie viele der fuenf Dimensionen mindestens beurteilbar sein muessen. */
  readonly minAssessedDimensions: number;
  /**
   * Untergrenze fuer JEDE einzelne beurteilte Dimension.
   *
   * Ohne sie waere der Mittelwert ein Ausgleichsmechanismus: 20 % der Felder
   * vorhanden und fuenf Widersprueche kaemen zusammen mit drei perfekten
   * Dimensionen immer noch auf 64 Punkte. Datenqualitaet ist aber nicht
   * ausgleichbar — eine kaputte Dimension bleibt kaputt, egal wie frisch der
   * Rest ist.
   */
  readonly minDimensionScore: number;
}

/**
 * Startwerte, ausdruecklich als Annahmen. Keiner ist gemessen.
 */
export const DEFAULT_DATA_QUALITY_GATE: DataQualityGate = {
  minScore: 60,
  minAssessedDimensions: 3,
  minDimensionScore: 40,
};

export type DataQualityVerdict =
  | { readonly kind: "PASS" }
  | {
      readonly kind: "FAIL";
      readonly reason: "SCORE_TOO_LOW" | "TOO_LITTLE_ASSESSED" | "DIMENSION_TOO_LOW";
      /** Bei DIMENSION_TOO_LOW: welche. */
      readonly dimension?: DataQualityDimension;
    };

/**
 * Drei getrennte Bedingungen, weil sie drei verschiedene Fehler abfangen:
 *
 * - zu wenig beurteilt — „wir wissen nicht, ob die Daten schlecht sind".
 *   Der gefaehrlichste Fall, weil er sich wie Erfolg anfuehlt.
 * - eine Dimension kaputt — der Mittelwert wuerde sie zudecken.
 * - Mittelwert zu niedrig — durchgehend mittelmaessige Daten.
 */
export function evaluateDataQualityGate(
  result: DataQualityResult,
  gate: DataQualityGate = DEFAULT_DATA_QUALITY_GATE,
): DataQualityVerdict {
  if (result.assessed.length < gate.minAssessedDimensions) {
    return { kind: "FAIL", reason: "TOO_LITTLE_ASSESSED" };
  }
  for (const dimension of result.assessed) {
    const value = result.perDimension[dimension];
    if (value !== undefined && value < gate.minDimensionScore) {
      return { kind: "FAIL", reason: "DIMENSION_TOO_LOW", dimension };
    }
  }
  if (result.score < gate.minScore) return { kind: "FAIL", reason: "SCORE_TOO_LOW" };
  return { kind: "PASS" };
}
