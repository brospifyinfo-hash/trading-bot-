/**
 * Jede externe Beobachtung, die in eine Trading-Entscheidung einfliesst, traegt
 * ihre Herkunft und ihren Beobachtungszeitpunkt mit sich.
 *
 * `observedAt` ist der Zeitpunkt, zu dem WIR den Wert gesehen haben — nicht der,
 * fuer den der Provider ihn datiert (`sourceTs`). Backtests filtern ausschliesslich
 * auf `observedAt`; alles andere waere Look-Ahead.
 */

export type ProviderId = string & { readonly __brand: "ProviderId" };

export const providerId = (id: string): ProviderId => id as ProviderId;

export interface Observation<T> {
  readonly kind: "OBSERVED";
  readonly value: T;
  readonly source: ProviderId;
  /** Wann WIR es gesehen haben. Der einzige Zeitstempel, den ein Backtest benutzen darf. */
  readonly observedAt: Date;
  /** Wofuer der Provider den Wert datiert. Rein informativ. */
  readonly sourceTs: Date | null;
  /** 0..1 — wie sicher die Quelle ist. Kein Score, sondern Datenqualitaet. */
  readonly confidence: number;
}

/**
 * Warum ein Wert fehlt. Bewusst geschlossen: der Grund landet im Rejection-Log
 * und muss dort auswertbar sein.
 */
export type MissingReason =
  | "PROVIDER_DOWN"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "NOT_SUPPORTED_BY_PROVIDER"
  | "NO_DATA_FOR_TOKEN"
  | "STALE_BEYOND_THRESHOLD"
  | "PARSE_FAILED"
  | "NOT_YET_COLLECTED"
  | "BUDGET_EXCEEDED";

export interface Missing {
  readonly kind: "MISSING";
  readonly reason: MissingReason;
  readonly source: ProviderId | null;
  readonly observedAt: Date;
}

/**
 * Ein moeglicherweise fehlender Trading-Input.
 *
 * Es gibt bewusst KEINEN Helfer, der daraus einen Defaultwert macht. Wer den Wert
 * braucht, muss den Fall MISSING sichtbar behandeln — der Compiler erzwingt das.
 */
export type Maybe<T> = Observation<T> | Missing;

export function observed<T>(
  value: T,
  source: ProviderId,
  observedAt: Date,
  opts: { sourceTs?: Date | null; confidence?: number } = {},
): Observation<T> {
  // Kein Ersatz fuer fehlende Daten: der Wert IST vorhanden, `confidence` ist nur
  // ein Metadatum darueber. Wer nichts angibt, meint "voll vertrauenswuerdig".
  // Ein fehlender Wert waere ein `Missing` und kaeme hier gar nicht erst an.
  // eslint-disable-next-line sae/no-numeric-fallback
  const confidence = opts.confidence ?? 1;
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new RangeError(`confidence muss in [0,1] liegen, war ${confidence}`);
  }
  return {
    kind: "OBSERVED",
    value,
    source,
    observedAt,
    sourceTs: opts.sourceTs ?? null,
    confidence,
  };
}

export function missing(
  reason: MissingReason,
  observedAt: Date,
  source: ProviderId | null = null,
): Missing {
  return { kind: "MISSING", reason, source, observedAt };
}

export function isPresent<T>(m: Maybe<T>): m is Observation<T> {
  return m.kind === "OBSERVED";
}

export function isMissing<T>(m: Maybe<T>): m is Missing {
  return m.kind === "MISSING";
}

/** Wendet eine Funktion auf den Wert an, laesst MISSING unveraendert durch. */
export function mapObservation<T, U>(m: Maybe<T>, fn: (value: T) => U): Maybe<U> {
  return m.kind === "OBSERVED" ? { ...m, value: fn(m.value) } : m;
}

/**
 * Holt den Wert heraus oder wirft. NUR erlaubt, wenn vorher ein Hard Gate die
 * Anwesenheit garantiert hat — nie als bequemer Ersatz fuer eine Fallunterscheidung.
 */
export function requireValue<T>(m: Maybe<T>, context: string): T {
  if (m.kind === "MISSING") {
    throw new Error(`Pflichtwert fehlt (${context}): ${m.reason}`);
  }
  return m.value;
}

/** Aelter als `maxAgeMs` bezogen auf `now`? Ein fehlender Wert gilt als veraltet. */
export function isStale<T>(m: Maybe<T>, now: Date, maxAgeMs: number): boolean {
  if (m.kind === "MISSING") return true;
  return now.getTime() - m.observedAt.getTime() > maxAgeMs;
}

/**
 * Anteil der vorhandenen Inputs, 0..1. Geht als `data_completeness` in die
 * Hard Gates ein: zu wenig Datengrundlage bedeutet NO TRADE, nicht "rate mal".
 */
export function dataCompleteness(inputs: ReadonlyArray<Maybe<unknown>>): number {
  if (inputs.length === 0) return 0;
  const present = inputs.filter(isPresent).length;
  return present / inputs.length;
}
