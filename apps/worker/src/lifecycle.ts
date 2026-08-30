import type { Logger } from "@sae/observability";

/**
 * Geordnetes Herunterfahren.
 *
 * Wichtig fuer den Execution-Worker: bei SIGTERM werden keine neuen Jobs mehr
 * angenommen, laufende Transaktionsbestaetigungen aber zu Ende gefuehrt. Ein
 * harter Abbruch mitten in einer gesendeten Transaktion erzeugt genau den
 * UNKNOWN-Zustand, den der Reconciler danach muehsam aufloesen muss.
 */
export class Lifecycle {
  readonly #shutdownHandlers: Array<() => Promise<void>> = [];
  readonly #logger: Logger;
  #shuttingDown = false;

  constructor(logger: Logger, private readonly graceMs = 30_000) {
    this.#logger = logger;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  onShutdown(handler: () => Promise<void>): void {
    this.#shutdownHandlers.push(handler);
  }

  install(): void {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        void this.shutdown(signal);
      });
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#logger.info({ reason }, "Herunterfahren eingeleitet");

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.graceMs));
    const handlers = Promise.all(this.#shutdownHandlers.map((h) => h()));

    await Promise.race([handlers, timeout]);
    this.#logger.info({ reason }, "Herunterfahren abgeschlossen");
  }
}
