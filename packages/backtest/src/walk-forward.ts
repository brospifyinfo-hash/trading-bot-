/**
 * Walk-Forward-Aufteilung.
 *
 * Der Zweck ist nicht Vollstaendigkeit, sondern Ehrlichkeit: Parameter werden auf
 * dem Trainingsfenster gesucht, auf dem Validierungsfenster geprueft und
 * ausschliesslich auf dem Out-of-Sample-Fenster BERICHTET. Wer die Zahlen aus dem
 * Fenster berichtet, auf dem er optimiert hat, misst seine eigene Anpassung.
 *
 * Rollierend, weil eine einzelne Aufteilung nur eine Stichprobe ist: eine
 * Strategie kann in genau einem Quartal funktionieren und sonst nie.
 */

export interface WalkForwardWindow {
  readonly index: number;
  readonly training: { readonly from: Date; readonly to: Date };
  readonly validation: { readonly from: Date; readonly to: Date };
  readonly outOfSample: { readonly from: Date; readonly to: Date };
}

export interface WalkForwardConfig {
  readonly from: Date;
  readonly to: Date;
  readonly trainingDays: number;
  readonly validationDays: number;
  readonly outOfSampleDays: number;
  /** Wie weit das Fenster je Schritt weiterrueckt. Ueblich: outOfSampleDays. */
  readonly stepDays: number;
}

const DAY_MS = 86_400_000;
const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * DAY_MS);

export function buildWalkForwardWindows(config: WalkForwardConfig): WalkForwardWindow[] {
  for (const [name, value] of Object.entries({
    trainingDays: config.trainingDays,
    validationDays: config.validationDays,
    outOfSampleDays: config.outOfSampleDays,
    stepDays: config.stepDays,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} muss eine positive ganze Zahl sein, war ${value}`);
    }
  }
  if (config.to <= config.from) {
    throw new RangeError("Der Zeitraum endet nicht nach seinem Beginn");
  }

  const windowDays = config.trainingDays + config.validationDays + config.outOfSampleDays;
  const totalDays = (config.to.getTime() - config.from.getTime()) / DAY_MS;
  if (totalDays < windowDays) {
    // Bewusst ein Fehler und kein gekuerztes Fenster: ein verkuerztes
    // Out-of-Sample-Fenster saehe wie ein gueltiges Ergebnis aus.
    throw new RangeError(
      `Zeitraum umfasst ${totalDays.toFixed(1)} Tage, ein Fenster braucht ${windowDays}`,
    );
  }

  const windows: WalkForwardWindow[] = [];
  let start = config.from;
  let index = 0;

  while (addDays(start, windowDays) <= config.to) {
    const trainingTo = addDays(start, config.trainingDays);
    const validationTo = addDays(trainingTo, config.validationDays);
    const outOfSampleTo = addDays(validationTo, config.outOfSampleDays);

    windows.push({
      index,
      training: { from: start, to: trainingTo },
      validation: { from: trainingTo, to: validationTo },
      outOfSample: { from: validationTo, to: outOfSampleTo },
    });

    start = addDays(start, config.stepDays);
    index += 1;
  }

  return windows;
}

/**
 * Prueft, dass die Fenster einer Aufteilung sich nicht ueberschneiden.
 *
 * Ein Out-of-Sample-Fenster, das in das Trainingsfenster hineinragt, ist kein
 * Out-of-Sample-Fenster mehr — und der Fehler ist im Ergebnis nicht zu sehen.
 */
export function assertNoOverlapWithin(window: WalkForwardWindow): void {
  if (window.training.to > window.validation.from) {
    throw new RangeError(`Fenster ${window.index}: Training ragt in die Validierung`);
  }
  if (window.validation.to > window.outOfSample.from) {
    throw new RangeError(`Fenster ${window.index}: Validierung ragt ins Out-of-Sample`);
  }
}
