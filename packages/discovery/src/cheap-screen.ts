import { isPresent, type Maybe, type RejectionReason } from "@sae/core";
import type { StrategyParameters } from "@sae/config";
import type { DiscoveredToken } from "./types";

/**
 * Billiges Vorsieb.
 *
 * Es steht vor der teuren Anreicherung und hat einen einzigen Zweck: das
 * Provider-Budget schuetzen. Rund neun von zehn entdeckten Tokens fallen hier
 * heraus, und zwar mit Daten, die die Discovery-Quelle ohnehin schon mitliefert
 * oder die ein einziger RPC-Aufruf ergibt.
 *
 * Die Reihenfolge ist damit ein Kostenmodell, keine Logik-Praeferenz. Ein Token,
 * das hier scheitert, kostet fast nichts — eines, das erst nach Holder-Analyse,
 * Wallet-Clustering und Social-Abfrage abgelehnt wird, kostet ein Vielfaches.
 *
 * WICHTIG: Das Sieb ist absichtlich grob. Es soll offensichtlich Ungeeignetes
 * aussortieren, nicht bewerten. Wer hier zu fein filtert, verliert Kandidaten,
 * bevor die eigentliche Analyse sie je gesehen hat — und merkt es nie, weil sie
 * im Rejection-Log unter einem groben Grund verschwinden.
 */

export interface CheapScreenInput {
  readonly token: DiscoveredToken;
  /** Aus einem einzelnen RPC-Aufruf, falls verfuegbar. */
  readonly mintAuthorityActive: Maybe<boolean>;
  readonly freezeAuthorityActive: Maybe<boolean>;
  readonly now: Date;
  readonly parameters: StrategyParameters;
  /** Bereits als Betrug bekannt — Ergebnis frueherer Laeufe. */
  readonly blacklisted: boolean;
}

export interface CheapScreenResult {
  readonly passed: boolean;
  readonly reasons: readonly RejectionReason[];
  /** Ob der Token weiter beobachtet wird, statt endgueltig zu verschwinden. */
  readonly keepWatching: boolean;
}

/**
 * Gruende, die einen Token ENDGUELTIG ausschliessen. Alles andere ist eine
 * Momentaufnahme: zu geringe Liquiditaet kann sich in fuenf Minuten aendern,
 * eine aktive Mint-Authority in aller Regel nicht.
 */
const TERMINAL_REASONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  "TOKEN_BLACKLISTED",
  "MINT_AUTHORITY_ACTIVE",
  "FREEZE_AUTHORITY_ACTIVE",
]);

export function cheapScreen(input: CheapScreenInput): CheapScreenResult {
  const reasons: RejectionReason[] = [];
  const { token, parameters, now } = input;

  if (input.blacklisted) reasons.push("TOKEN_BLACKLISTED");

  if (isPresent(input.mintAuthorityActive) && input.mintAuthorityActive.value) {
    reasons.push("MINT_AUTHORITY_ACTIVE");
  }
  if (isPresent(input.freezeAuthorityActive) && input.freezeAuthorityActive.value) {
    reasons.push("FREEZE_AUTHORITY_ACTIVE");
  }

  if (isPresent(token.liquidityUsd)) {
    // Grosszuegiger als das eigentliche Gate: hier wird nur aussortiert, was
    // auch nach jedem plausiblen Zuwachs nicht in Frage kaeme.
    const floor = parameters.entryGates.minLiquidityUsd * 0.5;
    if (token.liquidityUsd.value < floor) reasons.push("LIQUIDITY_TOO_LOW");
  }

  if (isPresent(token.marketCapUsd)) {
    if (token.marketCapUsd.value > parameters.entryGates.maxMarketCapUsd * 2) {
      reasons.push("FINAL_SCORE_TOO_LOW");
    }
  }

  if (token.launchedAt !== null) {
    const ageSeconds = (now.getTime() - token.launchedAt.getTime()) / 1_000;
    if (ageSeconds < 0) {
      // Ein Token aus der Zukunft heisst: die Quelle hat eine falsch gestellte
      // Uhr oder liefert Muell. Beides ist ein Grund, ihm nicht zu trauen.
      reasons.push("DATA_STALE");
    } else if (ageSeconds < parameters.entryGates.minTokenAgeSeconds) {
      reasons.push("DATA_INCOMPLETE");
    }
  }

  const terminal = reasons.some((r) => TERMINAL_REASONS.has(r));
  return {
    passed: reasons.length === 0,
    reasons,
    // Nur vorruebergehend gescheiterte Tokens bleiben in Beobachtung. Genau die
    // sind spaeter die Kontrollgruppe: ohne sie beruht jede Faktoranalyse
    // ausschliesslich auf dem, was wir gehandelt haben.
    keepWatching: reasons.length > 0 && !terminal,
  };
}
