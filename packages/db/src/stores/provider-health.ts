import { and, desc, gte, sql } from "drizzle-orm";
import type { ProviderStatusReport } from "@sae/providers";

import type { Database } from "../client";
import { providerStatusSamples } from "../schema/pipeline";

/**
 * Provider-Zustand als Verlauf, nicht als Momentaufnahme.
 *
 * Der Worker misst, das Dashboard liest — die beiden Prozesse reden nicht
 * miteinander. Ein Statusfeld im Speicher des Workers ist fuer die Anzeige
 * nicht da.
 *
 * Geschrieben wird eine Zeile je Messung. „Seit wann ist das gesperrt"
 * beantwortet keine Momentaufnahme, und genau das ist die Frage, die man beim
 * Hinsehen hat.
 */
export class ProviderHealthStore {
  constructor(private readonly db: Database) {}

  /**
   * Schreibt eine Messreihe.
   *
   * `ON CONFLICT DO NOTHING` auf `(provider_id, observed_at)`: derselbe Takt
   * zweimal ausgefuehrt erzeugt keinen zweiten Messpunkt. Das ist kein
   * Schoenheitsfehler — doppelte Messpunkte wuerden jede Auswertung ueber die
   * Zeit verzerren.
   */
  async record(reports: readonly ProviderStatusReport[], observedAt: Date): Promise<number> {
    if (reports.length === 0) return 0;

    const rows = reports.map((r) => ({
      providerId: String(r.providerId),
      kind: r.kind,
      status: r.status,
      capabilities: [...r.capabilities],
      observedAt,
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
      lastFailureReason: r.lastFailureReason,
      latencyMsP50: r.latencyMsP50,
      latencyMsP95: r.latencyMsP95,
      rateLimitRemaining: r.rateLimit?.remaining ?? null,
      rateLimitLimit: r.rateLimit?.limit ?? null,
      rateLimitResetAt: r.rateLimit?.resetAt ?? null,
      dataFreshnessSeconds: r.dataFreshnessSeconds,
      detail: r.detail,
    }));

    const inserted = await this.db
      .insert(providerStatusSamples)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: providerStatusSamples.id });
    return inserted.length;
  }

  /**
   * Juengste Messung je Anbieter.
   *
   * `DISTINCT ON` ist hier die richtige Form: eine Momentaufnahme aus einem
   * Verlauf. Der Umweg ueber ein Maximum je Anbieter und einen Selbst-Join
   * liefert dasselbe, liest sich aber schlechter und ist bei gleichen
   * Zeitstempeln nicht eindeutig.
   */
  async latest(): Promise<readonly (typeof providerStatusSamples.$inferSelect)[]> {
    const rows = await this.db
      .select()
      .from(providerStatusSamples)
      .orderBy(
        providerStatusSamples.providerId,
        desc(providerStatusSamples.observedAt),
      );

    const seen = new Set<string>();
    const out: (typeof providerStatusSamples.$inferSelect)[] = [];
    for (const row of rows) {
      if (seen.has(row.providerId)) continue;
      seen.add(row.providerId);
      out.push(row);
    }
    return out;
  }

  /**
   * Gibt es eine benutzbare Marktdatenquelle?
   *
   * Die Frage, an der die Startbedingung des ganzen Systems haengt. Sie wird
   * aus den PERSISTIERTEN Messungen beantwortet, nicht aus dem Speicher des
   * fragenden Prozesses: der Scheduler misst nicht selbst, und ein Anbieter,
   * der um 3 Uhr wiederkommt, soll ohne Neustart bemerkt werden.
   *
   * Ohne jede Messung ist die Antwort `false`. Nicht „vielleicht" und nicht
   * optimistisch — ohne Messung ist nichts bekannt, und ein unbekannter
   * Zustand darf keinen Handel ausloesen.
   */
  async anyMarketDataUsable(): Promise<boolean> {
    const rows = await this.latest();
    return rows.some((row) => {
      const capabilities = Array.isArray(row.capabilities) ? row.capabilities : [];
      const isMarket = capabilities.includes("TOKEN_MARKET");
      return isMarket && (row.status === "CONNECTED" || row.status === "DEGRADED");
    });
  }

  /** Verlauf eines Anbieters, juengste zuerst. */
  async history(providerId: string, since: Date, limit = 500): Promise<
    readonly (typeof providerStatusSamples.$inferSelect)[]
  > {
    return this.db
      .select()
      .from(providerStatusSamples)
      .where(
        and(
          sql`${providerStatusSamples.providerId} = ${providerId}`,
          gte(providerStatusSamples.observedAt, since),
        ),
      )
      .orderBy(desc(providerStatusSamples.observedAt))
      .limit(limit);
  }

  /**
   * Seit wann ein Anbieter ununterbrochen denselben Zustand hat.
   *
   * Die Frage, die die Anzeige beantworten soll. `null`, wenn es keine Messung
   * gibt — und ausdruecklich nicht „seit jetzt".
   */
  async statusSince(providerId: string): Promise<{ status: string; since: Date } | null> {
    const rows = await this.db
      .select({ status: providerStatusSamples.status, observedAt: providerStatusSamples.observedAt })
      .from(providerStatusSamples)
      .where(sql`${providerStatusSamples.providerId} = ${providerId}`)
      .orderBy(desc(providerStatusSamples.observedAt))
      .limit(500);

    const first = rows[0];
    if (first === undefined) return null;

    let since = first.observedAt;
    for (const row of rows) {
      if (row.status !== first.status) break;
      since = row.observedAt;
    }
    return { status: first.status, since };
  }
}
