import type { Clock, ProviderId, TokenId } from "@sae/core";
import type { Sourced, SourceTier } from "@sae/providers";

import { idempotencyKey } from "./idempotency";

/**
 * Aufnahme von Marktdaten in die Historie.
 *
 * Hier laufen drei Anforderungen zusammen, die alle dieselbe Wurzel haben:
 * **ein Snapshot ist eine Behauptung ueber einen Zeitpunkt**, und die muss
 * stimmen.
 *
 * 1. **Herkunft.** Jeder Snapshot traegt Anbieter, Qualitaetsstufe und Frische.
 *    Ohne diese Angaben laesst sich spaeter nicht sagen, ob eine Entscheidung
 *    auf Primaerdaten oder auf einem Fallback beruhte — und dann ist jede
 *    Auswertung nach Datenqualitaet unmoeglich.
 * 2. **Keine Zukunft.** Ein Beobachtungszeitpunkt nach der eigenen Uhr wird
 *    abgewiesen. Eine Uhrendrift beim Anbieter wuerde sonst Daten in die
 *    Historie schreiben, die es zum Entscheidungszeitpunkt noch nicht gab —
 *    und der PitReader wuerde sie brav ausliefern.
 * 3. **Kein Ersatz bei Ausfall.** Liefert die Kette nichts, entsteht kein
 *    Snapshot. Nicht der letzte bekannte Wert, nicht null, nicht ein
 *    interpolierter — gar keiner.
 */

export interface MarketObservation {
  readonly priceUsd: number;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly holders: number | null;
}

export interface SnapshotProvenance {
  readonly providerId: ProviderId;
  readonly tier: SourceTier;
  readonly freshnessSeconds: number;
  /** Weitere Anbieter, falls der Datensatz zusammengesetzt ist. */
  readonly contributors: readonly { providerId: ProviderId; tier: SourceTier }[];
}

export interface SnapshotCandidate {
  readonly tokenId: TokenId;
  readonly observedAt: Date;
  readonly ingestedAt: Date;
  readonly market: MarketObservation;
  readonly provenance: SnapshotProvenance;
  /** Stabiler Schluessel. Derselbe Datenpunkt ergibt denselben Wert. */
  readonly ingestKey: string;
}

export type IngestDecision =
  | { readonly kind: "ACCEPT"; readonly candidate: SnapshotCandidate }
  | { readonly kind: "DUPLICATE"; readonly ingestKey: string }
  | { readonly kind: "REJECT_FUTURE"; readonly observedAt: Date; readonly now: Date }
  | { readonly kind: "REJECT_STALE"; readonly ageSeconds: number; readonly maxAgeSeconds: number }
  | { readonly kind: "REJECT_NO_SOURCE"; readonly reason: string }
  | { readonly kind: "REJECT_INVALID"; readonly reason: string };

export interface IngestSettings {
  /**
   * Aelter als das darf eine Beobachtung nicht sein, um als aktueller Stand zu
   * gelten.
   *
   * Annahme, keine Messung: bei einem frisch gelisteten Token ist eine Minute
   * eine andere Welt. Sobald echte Latenzen bekannt sind, gehoert der Wert
   * ueberprueft.
   */
  readonly maxAgeSeconds: number;
  /** Toleranz gegen leichte Uhrendrift beim Anbieter. */
  readonly clockSkewToleranceSeconds: number;
}

export const DEFAULT_INGEST_SETTINGS: IngestSettings = {
  maxAgeSeconds: 120,
  clockSkewToleranceSeconds: 5,
};

export interface SeenKeys {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

export class InMemorySeenKeys implements SeenKeys {
  readonly #keys = new Set<string>();
  async has(key: string): Promise<boolean> {
    return this.#keys.has(key);
  }
  async add(key: string): Promise<void> {
    this.#keys.add(key);
  }
  get size(): number {
    return this.#keys.size;
  }
}

export function snapshotIngestKey(input: {
  readonly tokenId: TokenId;
  readonly observedAt: Date;
  readonly providerId: ProviderId;
}): string {
  return idempotencyKey("snapshot", {
    tokenId: input.tokenId,
    // Auf die Sekunde gerundet: zwei Abrufe derselben Anbieterbeobachtung
    // unterscheiden sich sonst durch Millisekunden und erzeugen zwei Snapshots
    // desselben Datenpunkts.
    observedAt: Math.floor(input.observedAt.getTime() / 1_000),
    providerId: input.providerId,
  });
}

/**
 * Entscheidet, ob aus einer Kettenantwort ein Snapshot wird.
 *
 * `sourcedValue` ist `null`, wenn die Kette nichts geliefert hat. Genau dann
 * entsteht nichts — das ist die technische Fassung von „ein Datenausfall darf
 * kein gueltiges Handelssignal erzeugen".
 */
export async function decideIngest(input: {
  readonly tokenId: TokenId;
  readonly sourcedValue: Sourced<MarketObservation> | null;
  readonly noSourceReason?: string;
  readonly seen: SeenKeys;
  readonly clock: Clock;
  readonly settings?: Partial<IngestSettings>;
  readonly extraContributors?: readonly { providerId: ProviderId; tier: SourceTier }[];
}): Promise<IngestDecision> {
  const settings = { ...DEFAULT_INGEST_SETTINGS, ...input.settings };
  const now = input.clock.now();

  if (input.sourcedValue === null) {
    return {
      kind: "REJECT_NO_SOURCE",
      reason: input.noSourceReason ?? "Keine Quelle lieferte Daten.",
    };
  }

  const { value, observedAt, providerId, tier, freshnessSeconds } = input.sourcedValue;

  if (!Number.isFinite(value.priceUsd) || value.priceUsd <= 0) {
    // Ein Preis von null oder NaN ist kein Preis. Ihn zu speichern hiesse, dem
    // PitReader eine Beobachtung zu geben, die er spaeter ausliefert.
    return { kind: "REJECT_INVALID", reason: `Preis ${String(value.priceUsd)} ist unbrauchbar.` };
  }

  const aheadSeconds = (observedAt.getTime() - now.getTime()) / 1_000;
  if (aheadSeconds > settings.clockSkewToleranceSeconds) {
    return { kind: "REJECT_FUTURE", observedAt, now };
  }

  const ageSeconds = Math.max(0, (now.getTime() - observedAt.getTime()) / 1_000);
  if (ageSeconds > settings.maxAgeSeconds) {
    return { kind: "REJECT_STALE", ageSeconds, maxAgeSeconds: settings.maxAgeSeconds };
  }

  const ingestKey = snapshotIngestKey({ tokenId: input.tokenId, observedAt, providerId });
  if (await input.seen.has(ingestKey)) {
    return { kind: "DUPLICATE", ingestKey };
  }

  return {
    kind: "ACCEPT",
    candidate: {
      tokenId: input.tokenId,
      observedAt,
      ingestedAt: now,
      market: value,
      provenance: {
        providerId,
        tier,
        freshnessSeconds,
        contributors: [
          { providerId, tier },
          ...(input.extraContributors ?? []),
        ],
      },
      ingestKey,
    },
  };
}

/** Schreibt den Schluessel fort. Erst NACH erfolgreichem Speichern aufrufen. */
export async function markIngested(seen: SeenKeys, candidate: SnapshotCandidate): Promise<void> {
  await seen.add(candidate.ingestKey);
}

/**
 * Ob dieser Snapshot eine Einstiegsentscheidung tragen darf.
 *
 * Fallback-Daten duerfen beobachtet und gespeichert werden — sie sind besser
 * als nichts fuer die Historie. Eine Einstiegsentscheidung tragen sie nicht:
 * dort geht es um Geld, und die Qualitaetsstufe ist genau die Information, die
 * das entscheidet.
 */
export function snapshotSupportsEntry(
  provenance: SnapshotProvenance,
  settings: IngestSettings = DEFAULT_INGEST_SETTINGS,
): { readonly allowed: boolean; readonly reason: string } {
  if (provenance.tier === "FALLBACK") {
    return { allowed: false, reason: "Fallback-Daten tragen keine Einstiegsentscheidung." };
  }
  if (provenance.freshnessSeconds > settings.maxAgeSeconds) {
    return {
      allowed: false,
      reason: `Daten ${provenance.freshnessSeconds.toFixed(0)} s alt, erlaubt sind ${settings.maxAgeSeconds} s.`,
    };
  }
  return { allowed: true, reason: "" };
}
