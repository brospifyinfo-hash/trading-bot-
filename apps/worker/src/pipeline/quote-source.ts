import { missing, type Maybe } from "@sae/core";
import type { ExecutionPlan, QuoteSource } from "@sae/trading";
import type { bps } from "@sae/core";

/**
 * Eine Kursquelle, die ehrlich nichts weiss.
 *
 * Der simulierte Ausfuehrer braucht eine Quelle, um ueberhaupt gebaut werden
 * zu koennen. Solange kein Router-Vertrag belegt ist, gibt es keinen Kurs —
 * und dann wird auch keiner geschaetzt.
 *
 * Das ist wichtiger, als es aussieht: ein Ausfuehrer mit einem erfundenen Kurs
 * wuerde Paper-Positionen mit erfundenen Einstiegen erzeugen, und die
 * spaetere Statistik haette keine Chance, das noch zu bemerken.
 */
export class UnavailableQuoteSource implements QuoteSource {
  async quote(
    plan: ExecutionPlan,
  ): Promise<Maybe<{ outAmount: bigint; priceImpactBps: ReturnType<typeof bps> }>> {
    void plan;
    return missing("NOT_YET_COLLECTED", new Date(0), null);
  }
}
