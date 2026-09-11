import { systemClock, type Clock } from "@sae/core";
import {
  recordSecurityFinding,
  selectTokensNeedingSecurity,
  type Database,
  type SecurityFinding,
} from "@sae/db";
import { tally, type Logger } from "@sae/observability";
import {
  RugcheckReportAdapter,
  holderConcentration,
  lpLockedPct,
  type RugcheckOutcome,
} from "@sae/providers";

/**
 * Sicherheitsbefunde nachladen.
 *
 * Der Takt, der das letzte fehlende Pflichtfeld liefert:
 * `top10HolderSharePct` macht den Sicherheits-Teilscore rechenbar und hebt die
 * Gewichtsabdeckung von 0.50 auf 0.70 (DECISIONS §111). Erst damit bildet die
 * Score-Engine ueberhaupt einen Endscore.
 *
 * ### Warum er langsam ist
 *
 * Gemessenes Rate-Limit: `x-rate-limit-limit: 15`, Zeitfenster unbekannt. Bei
 * fuenf Token je Lauf und einem Lauf alle fuenf Minuten sind das rund eine
 * Anfrage je Minute — weit genug entfernt, dass ein Ausreisser nichts kostet.
 * Im Marktdaten-Takt (25 Token alle 20 Sekunden) waere der Anbieter sofort
 * dicht.
 *
 * Das ist keine Sparsamkeit, sondern die Natur der Daten: eine
 * Mint-Autoritaet aendert sich nicht im Sekundentakt. Sie oft abzufragen
 * kostet Kontingent und liefert dieselbe Antwort.
 */

/** Wie viele Token ein Lauf hoechstens anfasst. */
const MAX_TOKENS_PER_RUN = 5;

/**
 * Ab wann ein Befund als veraltet gilt.
 *
 * Sechs Stunden. Autoritaeten und LP-Sperren aendern sich selten, die
 * Halterverteilung schon eher — aber nicht so schnell, dass ein Wert von
 * heute Morgen eine Entscheidung verdirbt. Kuerzer waere Kontingent ohne
 * Erkenntnis.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1_000;

export interface SecurityEnrichmentDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
}

export interface SecurityEnrichmentResult {
  readonly status: "OK" | "NOT_CONFIGURED" | "NO_TOKENS";
  readonly processed: number;
  readonly written: number;
  /** Wie oft welcher Ausgang eintrat — der Grund, wenn nichts geschrieben wurde. */
  readonly outcomes: Readonly<Record<string, number>>;
  /** Kleinster gemeldeter Rest am Limit. `null`, wenn der Anbieter keinen schickt. */
  readonly rateLimitRemaining: number | null;
}

export async function enrichSecurity(
  deps: SecurityEnrichmentDeps,
): Promise<SecurityEnrichmentResult> {
  const leer = { processed: 0, written: 0, outcomes: {}, rateLimitRemaining: null };
  if (deps.baseUrl === undefined || deps.baseUrl.trim() === "") {
    // Kein Anbieter, kein Befund. Ausdruecklich kein leerer Datensatz: eine
    // Zeile ohne Werte saehe im Feature-Vektor wie „geprueft und unauffaellig"
    // aus, und das waere die gefaehrlichste Luege des Systems.
    return { status: "NOT_CONFIGURED", ...leer };
  }

  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const tokens = await selectTokensNeedingSecurity(
    deps.db,
    deps.maxTokens ?? MAX_TOKENS_PER_RUN,
    new Date(now.getTime() - STALE_AFTER_MS),
  );
  if (tokens.length === 0) return { status: "NO_TOKENS", ...leer };

  const adapter = new RugcheckReportAdapter({
    clock,
    baseUrl: deps.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const outcomes: Record<string, number> = {};
  let written = 0;
  let rateLimitRemaining: number | null = null;

  for (const token of tokens) {
    const outcome = await adapter.fetchReport(token.mint);
    const bisher = outcomes[outcome.kind];
    outcomes[outcome.kind] = bisher === undefined ? 1 : bisher + 1;

    if (outcome.kind === "RATE_LIMITED") {
      // Abbrechen, nicht weiterprobieren. Die naechste Anfrage wuerde
      // dasselbe Ergebnis bringen und den Rest nur tiefer ins Limit treiben;
      // in fuenf Minuten laeuft der Takt ohnehin wieder.
      rateLimitRemaining = outcome.rateLimit.remaining;
      break;
    }
    if (outcome.kind !== "OK") continue;

    if (outcome.rateLimit.remaining !== null) {
      rateLimitRemaining =
        rateLimitRemaining === null
          ? outcome.rateLimit.remaining
          : Math.min(rateLimitRemaining, outcome.rateLimit.remaining);
    }

    await recordSecurityFinding(deps.db, toFinding(token.id, outcome, adapter.schemaVersion), now);
    written += 1;
  }

  deps.logger.info(
    {
      role: "security-enrichment",
      processed: tokens.length,
      written,
      reasons: tally(outcomes),
      ...(rateLimitRemaining !== null ? { rateLimitRemaining } : {}),
    },
    "Sicherheitsbefunde nachgeladen",
  );

  return { status: "OK", processed: tokens.length, written, outcomes, rateLimitRemaining };
}

/**
 * Aus dem Anbieterbericht ein Datenbankfeld.
 *
 * Die Autoritaeten kommen aus `token.*` und ausdruecklich nicht von der
 * obersten Ebene: dort ist `mintAuthority` bei USDC ein ganzes Konto-Objekt,
 * und wer es als Wahrheitswert liest, haelt ausgerechnet den unbedenklichsten
 * Token fuer gefaehrlich — oder umgekehrt (DECISIONS §113).
 */
function toFinding(
  tokenId: string,
  outcome: Extract<RugcheckOutcome, { kind: "OK" }>,
  checkVersion: string,
): SecurityFinding {
  const report = outcome.report;
  const concentration = holderConcentration(report);
  const lpLocked = lpLockedPct(report);

  return {
    tokenId,
    checkVersion,
    mintAuthorityActive: report.token.mintAuthority !== null,
    freezeAuthorityActive: report.token.freezeAuthority !== null,
    top10HolderSharePct: concentration?.top10Pct ?? null,
    topHolderSharePct: concentration?.topPct ?? null,
    devHoldingPct: concentration?.creatorPct ?? null,
    securityScore: Math.round(report.score_normalised),
    findings: {
      // Der LP-Sperranteil hat keine eigene Spalte, und der vorhandene
      // Wahrheitswert `lp_burned_or_locked` verlangte eine Schwelle, die
      // niemand gemessen hat: ist ein zu 72,9 % gesperrter Pool „gesperrt"?
      // Die Zahl steht deshalb hier — nichts geht verloren, und niemand muss
      // eine Grenze erfinden, die den Score deckelt.
      lpLockedPct: lpLocked,
      rugged: report.rugged,
      score: report.score,
      // Nur die Namen. Beschreibungen sind Fliesstext des Anbieters und
      // haetten in einer Datenbankspalte nichts verloren.
      risks: report.risks.map((r) => r.name),
      ...(concentration !== null
        ? {
            distinctOwners: concentration.distinctOwners,
            excludedAccounts: concentration.excludedAccounts,
          }
        : {}),
      totalHolders: report.totalHolders,
    },
  };
}
