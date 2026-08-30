import type { Clock } from "@sae/core";

/**
 * Token-Bucket je Provider.
 *
 * Zweck ist nicht Hoeflichkeit, sondern Verfuegbarkeit: wer einen Anbieter ins
 * Rate Limit treibt, hat danach fuer alle Tokens keine Daten mehr — auch fuer die
 * offenen Positionen, die gerade ueberwacht werden muessen. Die Drosselung ist
 * deshalb Teil der Risikoarchitektur, nicht der Etikette.
 *
 * `reserve` gibt zurueck, wie lange gewartet werden muss, statt selbst zu warten.
 * So bleibt die Entscheidung, ob ein Aufruf sich noch lohnt, beim Aufrufer — bei
 * einer Exit-Pruefung ist eine Sekunde Wartezeit etwas anderes als bei Discovery.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #clock: Clock;
  #tokens: number;
  #lastRefillMs: number;

  constructor(options: {
    readonly capacity: number;
    readonly refillPerSecond: number;
    readonly clock: Clock;
  }) {
    if (options.capacity <= 0) throw new RangeError("capacity muss positiv sein");
    if (options.refillPerSecond <= 0) throw new RangeError("refillPerSecond muss positiv sein");
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerSecond / 1_000;
    this.#clock = options.clock;
    this.#tokens = options.capacity;
    this.#lastRefillMs = options.clock.now().getTime();
  }

  get available(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }

  /** Nimmt einen Token, wenn verfuegbar. */
  tryTake(count = 1): boolean {
    this.#refill();
    if (this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  /**
   * Wie lange bis `count` Tokens verfuegbar sind, in Millisekunden.
   * 0 bedeutet: sofort — der Aufrufer muss `tryTake` trotzdem noch aufrufen.
   */
  waitMs(count = 1): number {
    this.#refill();
    if (this.#tokens >= count) return 0;
    return Math.ceil((count - this.#tokens) / this.#refillPerMs);
  }

  #refill(): void {
    const now = this.#clock.now().getTime();
    const elapsed = now - this.#lastRefillMs;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefillMs = now;
  }
}
