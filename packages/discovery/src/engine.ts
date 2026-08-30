import { isPresent, type Clock, type Maybe, type Mint, type RejectionReason } from "@sae/core";
import type { StrategyParameters } from "@sae/config";
import { deduplicate, type SeenStore } from "./dedup";
import { cheapScreen } from "./cheap-screen";
import type { DiscoveredToken, DiscoverySource } from "./types";

/**
 * Discovery-Durchlauf.
 *
 * Sammelt aus allen Quellen, dedupliziert, siebt billig vor und uebergibt nur den
 * Rest an die teure Anreicherung.
 *
 * Der Durchlauf ist gegenueber ausgefallenen Quellen tolerant: faellt eine aus,
 * laufen die anderen weiter. Er ist NICHT tolerant gegenueber stillem
 * Datenverlust — jede ausgefallene Quelle wird benannt, damit im Dashboard
 * sichtbar ist, dass die Abdeckung gerade unvollstaendig ist.
 */

export interface DiscoveryRunResult {
  readonly candidates: readonly DiscoveredToken[];
  readonly watchlist: readonly DiscoveredToken[];
  readonly rejected: ReadonlyMap<RejectionReason, number>;
  readonly duplicatesSkipped: number;
  readonly multiSourceMints: readonly Mint[];
  /** Quellen, die in diesem Durchlauf nichts geliefert haben. */
  readonly failedSources: readonly string[];
  readonly totalSeen: number;
}

export interface TokenAuthorities {
  readonly mintAuthorityActive: Maybe<boolean>;
  readonly freezeAuthorityActive: Maybe<boolean>;
}

export interface DiscoveryRunInput {
  readonly sources: readonly DiscoverySource[];
  readonly since: Date;
  readonly store: SeenStore;
  readonly clock: Clock;
  readonly parameters: StrategyParameters;
  readonly isBlacklisted: (mint: Mint) => Promise<boolean>;
  /**
   * Billige Autoritaetspruefung, typischerweise ein RPC-Aufruf je Mint.
   * Injiziert, weil sie in Phase 4 gegen die Chain geht und hier gegen Fixtures.
   */
  readonly checkAuthorities: (mint: Mint) => Promise<TokenAuthorities>;
}

export async function runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunResult> {
  const collected: DiscoveredToken[] = [];
  const failedSources: string[] = [];

  for (const source of input.sources) {
    const result = await source.discover(input.since);
    if (!isPresent(result)) {
      // Benannt, nicht verschwiegen: eine ausgefallene Quelle bedeutet
      // unvollstaendige Abdeckung, und das muss sichtbar sein.
      failedSources.push(`${source.id}:${result.reason}`);
      continue;
    }
    collected.push(...result.value);
  }

  const { fresh, duplicates, multiSourceMints } = await deduplicate(collected, input.store);

  const candidates: DiscoveredToken[] = [];
  const watchlist: DiscoveredToken[] = [];
  const rejected = new Map<RejectionReason, number>();

  for (const token of fresh) {
    const authorities = await input.checkAuthorities(token.mint);
    const screen = cheapScreen({
      token,
      mintAuthorityActive: authorities.mintAuthorityActive,
      freezeAuthorityActive: authorities.freezeAuthorityActive,
      now: input.clock.now(),
      parameters: input.parameters,
      blacklisted: await input.isBlacklisted(token.mint),
    });

    if (screen.passed) {
      candidates.push(token);
      continue;
    }
    for (const reason of screen.reasons) {
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
    }
    if (screen.keepWatching) watchlist.push(token);
  }

  return {
    candidates,
    watchlist,
    rejected,
    duplicatesSkipped: duplicates,
    multiSourceMints,
    failedSources,
    totalSeen: collected.length,
  };
}
