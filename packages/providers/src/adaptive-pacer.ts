import type { Clock } from "@sae/core";

/**
 * Ein Takt, der sich selbst einstellt.
 *
 * Das Problem, das er loest: die Grenze des Anbieters steht nirgends. Jupiter
 * meldet `429`, nennt aber keine Zahl, und die Dokumentation schweigt. Ein
 * fester Wert waere geraten — und jedes Raten hier kostet entweder Daten (zu
 * langsam) oder Anfragen (zu schnell).
 *
 * Die Messung vom 2026-09-11 zeigt beides: ungebremst gingen 21 von 25
 * Anfragen verloren, mit einer Anfrage je Sekunde immer noch 5 von 10. Die
 * richtige Zahl liegt irgendwo dazwischen, und sie kann sich beim Anbieter
 * jederzeit aendern.
 *
 * ### Wie er sich einstellt
 *
 * Klassisches AIMD — schnell zurueck, langsam vor:
 *
 * - Bei einer Abweisung wird der Abstand **multiplikativ** vergroessert. Wer
 *   gedrosselt wird, hat schon zu viel geschickt; vorsichtig
 *   heranzutasten hiesse, weiter zu verlieren.
 * - Nach einer Reihe von Erfolgen wird er **additiv** verkleinert. Schneller
 *   werden darf man nur, wenn es nachweislich gutgeht.
 *
 * Zwischen Boden und Decke, beide hart: der Boden verhindert, dass ein
 * kurzer guter Lauf uns zurueck in die Drosselung treibt; die Decke
 * verhindert, dass eine Stoerung den Takt auf Stunden hochzieht und der
 * Auftrag laenger laeuft als sein Zeitfenster.
 */

export interface AdaptivePacerOptions {
  readonly clock: Clock;
  /** Startabstand zwischen zwei Anfragen. */
  readonly startIntervalMs: number;
  /** Schnellster erlaubter Abstand. */
  readonly minIntervalMs: number;
  /**
   * Langsamster erlaubter Abstand.
   *
   * Eine harte Decke, kein Richtwert: ohne sie koennte eine anhaltende
   * Stoerung den Abstand so weit hochziehen, dass ein Auftrag sein Zeitfenster
   * ueberschreitet — und dann liegt nicht der Anbieter brach, sondern die
   * Queue.
   */
  readonly maxIntervalMs: number;
  /** Faktor, um den bei einer Abweisung verlangsamt wird. */
  readonly backoffFactor?: number;
  /** Wie viele Erfolge in Folge noetig sind, bevor beschleunigt wird. */
  readonly successesBeforeSpeedup?: number;
  /** Um wie viel dann beschleunigt wird. */
  readonly speedupStepMs?: number;
}

const DEFAULT_BACKOFF = 1.5;
const DEFAULT_SUCCESSES = 5;
const DEFAULT_SPEEDUP_MS = 250;

export class AdaptivePacer {
  readonly #clock: Clock;
  readonly #min: number;
  readonly #max: number;
  readonly #backoff: number;
  readonly #successesNeeded: number;
  readonly #speedupMs: number;

  #intervalMs: number;
  #lastAtMs: number | null = null;
  #successStreak = 0;

  constructor(options: AdaptivePacerOptions) {
    if (options.minIntervalMs <= 0) throw new RangeError("minIntervalMs muss positiv sein");
    if (options.maxIntervalMs < options.minIntervalMs) {
      throw new RangeError("maxIntervalMs darf nicht unter minIntervalMs liegen");
    }
    this.#clock = options.clock;
    this.#min = options.minIntervalMs;
    this.#max = options.maxIntervalMs;
    this.#backoff = options.backoffFactor ?? DEFAULT_BACKOFF;
    this.#successesNeeded = options.successesBeforeSpeedup ?? DEFAULT_SUCCESSES;
    this.#speedupMs = options.speedupStepMs ?? DEFAULT_SPEEDUP_MS;
    this.#intervalMs = clamp(options.startIntervalMs, this.#min, this.#max);
  }

  /** Der aktuelle Abstand — fuer das Log, damit sichtbar ist, wo er sich einpendelt. */
  get intervalMs(): number {
    return this.#intervalMs;
  }

  /**
   * Wie lange bis zur naechsten Anfrage gewartet werden muss.
   *
   * Ruft der Aufrufer das, gilt die Anfrage als gestellt — der naechste Aufruf
   * misst ab jetzt. Ein `waitMs`, das den Zeitpunkt NICHT setzt, waere in einer
   * Schleife wirkungslos: jeder Aufruf saehe denselben freien Zeitpunkt.
   */
  waitMs(): number {
    const now = this.#clock.now().getTime();
    const last = this.#lastAtMs;
    if (last === null) {
      this.#lastAtMs = now;
      return 0;
    }
    const frueheste = last + this.#intervalMs;
    const warten = Math.max(0, frueheste - now);
    this.#lastAtMs = Math.max(now, frueheste);
    return warten;
  }

  /** Der Anbieter hat abgewiesen: sofort deutlich langsamer. */
  onRateLimited(): void {
    this.#successStreak = 0;
    this.#intervalMs = clamp(Math.ceil(this.#intervalMs * this.#backoff), this.#min, this.#max);
  }

  /** Eine Anfrage ging durch. Beschleunigt wird erst nach einer Reihe davon. */
  onSuccess(): void {
    this.#successStreak += 1;
    if (this.#successStreak < this.#successesNeeded) return;
    this.#successStreak = 0;
    this.#intervalMs = clamp(this.#intervalMs - this.#speedupMs, this.#min, this.#max);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
