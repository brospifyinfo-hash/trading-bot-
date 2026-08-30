import type { Maybe, Mint, ProviderId } from "@sae/core";

/**
 * Token-Entdeckung.
 *
 * Der Bot wartet nicht darauf, dass jemand eine Adresse eingibt. Er sucht selbst.
 *
 * Die Quellen sind bewusst getrennt von der Bewertung: eine Discovery-Quelle
 * sagt nur "diesen Token gibt es und er ist mir aufgefallen", nicht "er ist gut".
 * Die Vermischung beider Rollen ist der Grund, warum viele Bots handeln, was
 * gerade auf einer Liste steht.
 */

export type DiscoveryTrigger =
  | "NEW_PAIR"
  | "NEW_LAUNCH"
  | "VOLUME_SPIKE"
  | "LIQUIDITY_GROWTH"
  | "HOLDER_GROWTH"
  | "TRANSACTION_SURGE"
  | "SMART_MONEY_ACTIVITY"
  | "SOCIAL_MOMENTUM";

/** Was eine Quelle liefert — bewusst wenig, weil alles Weitere Geld kostet. */
export interface DiscoveredToken {
  readonly mint: Mint;
  readonly trigger: DiscoveryTrigger;
  readonly source: ProviderId;
  /** Wann WIR den Token gesehen haben. */
  readonly observedAt: Date;
  /** Wann der Token laut Quelle entstanden ist, falls bekannt. */
  readonly launchedAt: Date | null;
  readonly symbol: string | null;
  readonly poolAddress: string | null;
  /** Grobwerte fuer das billige Vorsieb. Alles `Maybe` — Quellen fallen aus. */
  readonly liquidityUsd: Maybe<number>;
  readonly marketCapUsd: Maybe<number>;
}

export interface DiscoverySource {
  readonly id: ProviderId;
  readonly trigger: DiscoveryTrigger;
  /** Tokens, die seit `since` aufgefallen sind. */
  discover(since: Date): Promise<Maybe<readonly DiscoveredToken[]>>;
}
