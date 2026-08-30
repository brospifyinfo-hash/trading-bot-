import type { Maybe, MissingReason, TokenId } from "@sae/core";

/**
 * Feature-Vektor.
 *
 * Die einzige Eingabe der Score-Engine. Er wird ausschliesslich aus einem
 * `PitReader` gebaut — die Score-Engine selbst hat keinen Datenbankzugriff und
 * kann deshalb gar nicht versehentlich in die Zukunft schauen.
 *
 * Jedes Feld ist `Maybe`. Das ist keine Bequemlichkeit, sondern die Kernregel:
 * ein fehlender Wert ist ein fehlender Wert und wird nirgends zu einer Zahl.
 */

export interface SecurityFeatures {
  readonly mintAuthorityActive: Maybe<boolean>;
  readonly freezeAuthorityActive: Maybe<boolean>;
  readonly lpBurnedOrLocked: Maybe<boolean>;
  readonly top10HolderSharePct: Maybe<number>;
  readonly topHolderSharePct: Maybe<number>;
  readonly riskLevel: Maybe<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">;
}

export interface MarketFeatures {
  readonly priceUsd: Maybe<number>;
  readonly liquidityUsd: Maybe<number>;
  readonly marketCapUsd: Maybe<number>;
  readonly volume24hUsd: Maybe<number>;
  readonly tokenAgeSeconds: Maybe<number>;
}

export interface MomentumFeatures {
  /** Relative Preisaenderung ueber das Fenster, z. B. 0.12 = +12 %. */
  readonly priceChange5m: Maybe<number>;
  readonly priceChange1h: Maybe<number>;
  /** Verhaeltnis Volumen letzte 5 min zu Durchschnitt. > 1 heisst Beschleunigung. */
  readonly volumeAcceleration: Maybe<number>;
  readonly buys5m: Maybe<number>;
  readonly sells5m: Maybe<number>;
}

export interface HolderFeatures {
  readonly holders: Maybe<number>;
  /** Absolute Veraenderung der Holderzahl im Beobachtungsfenster. */
  readonly holderGrowth: Maybe<number>;
  /**
   * Holder nach Cluster-Bereinigung. Zehn Wallets mit gemeinsamer Funding-Quelle
   * sind ein Akteur, nicht zehn Kaeufer.
   */
  readonly distinctActors: Maybe<number>;
  readonly largestClusterSharePct: Maybe<number>;
}

export interface ExecutionFeatures {
  /** Erwartete Gesamtkosten einer Ausfuehrung in Basispunkten. */
  readonly expectedCostBps: Maybe<number>;
  /** Wie oft die geplante Position innerhalb der Impact-Grenze rausginge. */
  readonly exitCapacityRatio: Maybe<number>;
  readonly priceImpactBps: Maybe<number>;
}

/**
 * Kategorien, die erst in spaeteren Phasen befuellt werden.
 * Sie sind hier bereits vorhanden, damit die Score-Engine ihre Abwesenheit
 * korrekt als "nicht berechenbar" fuehrt statt sie zu ignorieren.
 */
export interface PendingFeatures {
  readonly smartMoneyBuyers: Maybe<number>;
  readonly smartMoneySellers: Maybe<number>;
  readonly socialAuthenticity: Maybe<number>;
  readonly socialMomentum: Maybe<number>;
  readonly devScore: Maybe<number>;
  readonly narrativeScore: Maybe<number>;
}

export interface FeatureVector {
  readonly tokenId: TokenId;
  /** Zeitpunkt, fuer den die Features gelten. Alle Inputs sind <= asOf. */
  readonly asOf: Date;
  readonly security: SecurityFeatures;
  readonly market: MarketFeatures;
  readonly momentum: MomentumFeatures;
  readonly holder: HolderFeatures;
  readonly execution: ExecutionFeatures;
  readonly pending: PendingFeatures;
}

export interface MissingField {
  readonly field: string;
  readonly reason: MissingReason;
}

/** Sammelt alle fehlenden Felder — Grundlage von `data_completeness`. */
export function collectMissing(vector: FeatureVector): MissingField[] {
  const out: MissingField[] = [];
  for (const [group, values] of Object.entries({
    security: vector.security,
    market: vector.market,
    momentum: vector.momentum,
    holder: vector.holder,
    execution: vector.execution,
    pending: vector.pending,
  })) {
    for (const [name, value] of Object.entries(values as unknown as Record<string, Maybe<unknown>>)) {
      if (value.kind === "MISSING") {
        out.push({ field: `${group}.${name}`, reason: value.reason });
      }
    }
  }
  return out;
}

export function countFields(vector: FeatureVector): number {
  return (
    Object.keys(vector.security).length +
    Object.keys(vector.market).length +
    Object.keys(vector.momentum).length +
    Object.keys(vector.holder).length +
    Object.keys(vector.execution).length +
    Object.keys(vector.pending).length
  );
}
