import type { Clock } from "@sae/core";

/**
 * Kostenbudget je Provider.
 *
 * Bei nutzungsabhaengiger Abrechnung ist eine ausser Kontrolle geratene Schleife
 * kein Leistungsproblem, sondern eine Rechnung. Der Waechter schaltet den
 * Anbieter auf DEGRADED, statt ihn weiterlaufen zu lassen — lieber weniger Daten
 * als eine Ueberraschung am Monatsende.
 *
 * Bewusst als Zaehler von Anfragen mit hinterlegtem Stueckpreis: die tatsaechliche
 * Abrechnung kennt nur der Anbieter, aber die Groessenordnung reicht, um zu
 * bremsen, bevor es teuer wird.
 */
export class ProviderBudget {
  readonly #monthlyLimitMicroUsd: bigint;
  readonly #costPerRequestMicroUsd: bigint;
  readonly #clock: Clock;
  #spentMicroUsd = 0n;
  #periodKey: string;

  constructor(options: {
    readonly monthlyLimitUsd: number;
    readonly costPerRequestUsd: number;
    readonly clock: Clock;
  }) {
    this.#monthlyLimitMicroUsd = BigInt(Math.round(options.monthlyLimitUsd * 1_000_000));
    this.#costPerRequestMicroUsd = BigInt(Math.round(options.costPerRequestUsd * 1_000_000));
    this.#clock = options.clock;
    this.#periodKey = periodKeyOf(options.clock.now());
  }

  /** 0..1, oder mehr als 1, wenn das Limit ueberschritten wurde. */
  get usedFraction(): number {
    this.#rolloverIfNewPeriod();
    if (this.#monthlyLimitMicroUsd === 0n) return 1;
    return Number((this.#spentMicroUsd * 10_000n) / this.#monthlyLimitMicroUsd) / 10_000;
  }

  get exhausted(): boolean {
    // Der Monatswechsel muss auch hier geprueft werden, nicht nur beim Buchen:
    // sonst bleibt ein aufgebrauchtes Budget haengen, bis zufaellig wieder eine
    // Anfrage kommt — und die wird ja gerade blockiert. Der Provider waere
    // dauerhaft still abgeschaltet.
    this.#rolloverIfNewPeriod();
    return this.#spentMicroUsd >= this.#monthlyLimitMicroUsd;
  }

  /** Bucht eine Anfrage. Gibt zurueck, ob danach noch Budget vorhanden ist. */
  chargeRequest(count = 1): boolean {
    this.#rolloverIfNewPeriod();
    this.#spentMicroUsd += this.#costPerRequestMicroUsd * BigInt(count);
    return !this.exhausted;
  }

  #rolloverIfNewPeriod(): void {
    const key = periodKeyOf(this.#clock.now());
    if (key !== this.#periodKey) {
      this.#periodKey = key;
      this.#spentMicroUsd = 0n;
    }
  }
}

function periodKeyOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}
