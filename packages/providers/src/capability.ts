import type { Clock, ProviderId } from "@sae/core";

import type { ProviderKind } from "./types";

/**
 * Was ein Provider kann, wie es ihm geht — und warum nicht.
 *
 * Die drei Stufen aus `ProviderHealthState` (HEALTHY/DEGRADED/DOWN) reichen fuer
 * die Handelslogik, aber nicht fuer die Anzeige. „DOWN" beantwortet die einzige
 * Frage nicht, die man beim Hinsehen hat: **liegt es an mir?**
 *
 *   NOT_CONFIGURED  Kein Schluessel, keine Basis-URL. Nichts kaputt, nur nichts da.
 *   BLOCKED         Das Netz laesst die Verbindung nicht zu. Der Anbieter ist
 *                   vermutlich gesund; erreichbar ist er trotzdem nicht.
 *   UNAVAILABLE     Konfiguriert, erreichbar sein muesste er, antwortet aber nicht.
 *   DEGRADED        Antwortet, aber eingeschraenkt: Fehlerrate, Rate Limit, Budget.
 *   CONNECTED       Liefert verwertbare Daten.
 *
 * Der Unterschied zwischen BLOCKED und UNAVAILABLE ist kein Detail. Der eine
 * Fall wird durch eine Netzwerkfreigabe geloest, der andere durch Warten oder
 * einen Anbieterwechsel — und im Moment ist ausschliesslich der erste der Grund,
 * warum dieses System keine Daten hat.
 */

export type ProviderStatus =
  | "CONNECTED"
  | "DEGRADED"
  | "BLOCKED"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED";

/** Was ein Anbieter tatsaechlich liefern kann. Nicht was er verspricht. */
export type ProviderCapability =
  | "TOKEN_DISCOVERY"
  | "TOKEN_MARKET"
  | "PRICE_HISTORY"
  | "ROUTE_QUOTE"
  | "SWAP_TRANSACTION"
  | "SECURITY_REPORT"
  | "HOLDER_DISTRIBUTION"
  | "SOCIAL_SIGNALS";

export interface RateLimitState {
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly resetAt: Date | null;
  /** Aus dem eigenen Token-Bucket, wenn der Anbieter nichts meldet. */
  readonly localTokensAvailable: number | null;
}

export interface ProviderStatusReport {
  readonly providerId: ProviderId;
  readonly kind: ProviderKind;
  readonly status: ProviderStatus;
  readonly capabilities: readonly ProviderCapability[];
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureReason: string | null;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
  readonly rateLimit: RateLimitState | null;
  /**
   * Alter der juengsten gelieferten Beobachtung, in Sekunden.
   * `null` = noch nie etwas geliefert — ausdruecklich nicht „frisch".
   */
  readonly dataFreshnessSeconds: number | null;
  readonly detail: string | null;
}

/* ----------------------------------------------------- Fehlerklassifikation */

export type FailureClass = "BLOCKED" | "UNAVAILABLE" | "RATE_LIMITED" | "BAD_REQUEST" | "UNKNOWN";

/**
 * Ordnet einen Fehlschlag einer Ursache zu.
 *
 * Bewusst konservativ: was nicht eindeutig als Netzsperre erkennbar ist, gilt
 * als `UNAVAILABLE`. Ein faelschlich als BLOCKED gemeldeter Anbieter wuerde die
 * Suche nach der echten Ursache in die falsche Richtung schicken.
 */
export function classifyFailure(input: {
  readonly httpStatus?: number | null;
  readonly errorCode?: string | null;
  readonly message?: string | null;
}): FailureClass {
  const message = (input.message ?? "").toLowerCase();
  const code = (input.errorCode ?? "").toUpperCase();

  // Ein Proxy, der CONNECT ablehnt, meldet 403 oder 407 — und zwar bevor der
  // Anbieter ueberhaupt gefragt wurde.
  if (
    message.includes("connect") &&
    (message.includes("403") || message.includes("407") || message.includes("tunnel"))
  ) {
    return "BLOCKED";
  }
  if (code === "EPROXYAUTH" || code === "ETUNNEL") return "BLOCKED";

  if (input.httpStatus === 429) return "RATE_LIMITED";
  if (input.httpStatus !== null && input.httpStatus !== undefined) {
    if (input.httpStatus >= 500) return "UNAVAILABLE";
    // 403, 407 und 451 heissen: etwas zwischen uns und dem Anbieter verweigert.
    // Ob das der Anbieter selbst ist oder ein Proxy davor, laesst sich von hier
    // aus nicht unterscheiden — und fuer die Folge ist es dasselbe: warten
    // hilft nicht, eine Freigabe schon. Genau das bedeutet BLOCKED.
    if (input.httpStatus === 403 || input.httpStatus === 407 || input.httpStatus === 451) {
      return "BLOCKED";
    }
    if (input.httpStatus >= 400) return "BAD_REQUEST";
  }

  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET"].includes(code)) {
    return "UNAVAILABLE";
  }
  if (message.includes("timeout") || message.includes("abort")) return "UNAVAILABLE";

  return "UNKNOWN";
}

/* ------------------------------------------------------------ Statusbildung */

export interface StatusInputs {
  readonly configured: boolean;
  readonly lastFailureClass: FailureClass | null;
  readonly hasEverSucceeded: boolean;
  readonly errorRate: number;
  readonly budgetExhausted: boolean;
  readonly breakerOpen: boolean;
  readonly secondsSinceLastSuccess: number | null;
  readonly maxSilenceSeconds: number;
  readonly degradedErrorRate: number;
}

export function deriveStatus(input: StatusInputs): ProviderStatus {
  // Nicht konfiguriert schlaegt alles: ein Anbieter ohne Zugangsdaten ist nicht
  // ausgefallen, es gibt ihn hier schlicht nicht.
  if (!input.configured) return "NOT_CONFIGURED";

  // Eine Netzsperre bleibt sichtbar, auch wenn frueher einmal etwas ankam —
  // sonst verdeckt ein alter Erfolg die aktuelle Ursache.
  if (input.lastFailureClass === "BLOCKED") return "BLOCKED";

  if (!input.hasEverSucceeded) {
    return input.lastFailureClass === null ? "UNAVAILABLE" : classToStatus(input.lastFailureClass);
  }

  if (input.breakerOpen) return "UNAVAILABLE";

  if (
    input.secondsSinceLastSuccess !== null &&
    input.secondsSinceLastSuccess > input.maxSilenceSeconds
  ) {
    return "UNAVAILABLE";
  }

  if (input.budgetExhausted || input.lastFailureClass === "RATE_LIMITED") return "DEGRADED";
  if (input.errorRate >= input.degradedErrorRate) return "DEGRADED";

  return "CONNECTED";
}

function classToStatus(failure: FailureClass): ProviderStatus {
  switch (failure) {
    case "BLOCKED":
      return "BLOCKED";
    case "RATE_LIMITED":
      return "DEGRADED";
    case "BAD_REQUEST":
      // Unser Aufruf war falsch, nicht der Anbieter kaputt. Trotzdem liefert er
      // nichts — also nicht CONNECTED.
      return "DEGRADED";
    default:
      return "UNAVAILABLE";
  }
}

/** Stroeme darf ein Provider nur tragen, wenn er tatsaechlich Daten liefert. */
export function statusAllowsUse(status: ProviderStatus): boolean {
  return status === "CONNECTED" || status === "DEGRADED";
}

/** Ob dieser Status eine Einstiegsentscheidung tragen darf. */
export function statusAllowsEntryDecision(status: ProviderStatus): boolean {
  return status === "CONNECTED";
}

/* ------------------------------------------------------------- Herkunft */

/**
 * Qualitaetsstufe einer Quelle.
 *
 * Nicht „gut/schlecht", sondern „wie weit unten in der Kette". Die Stufe wird an
 * jedem Datenpunkt mitgefuehrt, damit spaeter nachvollziehbar ist, worauf eine
 * Entscheidung beruhte.
 */
export type SourceTier = "PRIMARY" | "SECONDARY" | "FALLBACK";

export const TIER_ORDER: readonly SourceTier[] = ["PRIMARY", "SECONDARY", "FALLBACK"];

export function worseTier(a: SourceTier, b: SourceTier): SourceTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

export interface Sourced<T> {
  readonly value: T;
  readonly providerId: ProviderId;
  readonly tier: SourceTier;
  /**
   * Der Zeitpunkt, zu dem WIR den Zustand kannten — der Point-in-Time-Stempel.
   *
   * Liefert der Anbieter einen eigenen Beobachtungszeitpunkt, steht der hier.
   * Liefert er keinen, steht hier der Abrufzeitpunkt: wir wussten es dann, und
   * frueher nachweislich nicht. Als PIT-Stempel ist das korrekt und erzeugt
   * kein Look-Ahead — es ist nur eine schwaechere Aussage.
   */
  readonly observedAt: Date;
  /** Wann wir sie geholt haben. */
  readonly fetchedAt: Date;
  /**
   * Wie alt die Daten beim Abruf waren — oder `null`, wenn niemand es weiss.
   *
   * `null` heisst UNBEKANNT und ausdruecklich nicht 0. Das ist der Grund,
   * warum dieses Feld nullable ist: DexScreener liefert nachweislich keinen
   * Zeitstempel zur Preisangabe (geprueft an einer echten Antwort, siehe
   * `dexscreener/schema.ts`). Hier 0 einzutragen waere die bequemste und
   * teuerste Luege des Systems — sie behauptet Frische, die nie gemessen
   * wurde, und der Einstiegs-Gate wuerde sie glauben.
   *
   * Wer eine Einstiegsentscheidung darauf stuetzen will, braucht eine Zahl.
   * `null` traegt sie nicht.
   */
  readonly freshnessSeconds: number | null;
}

export function sourced<T>(input: {
  readonly value: T;
  readonly providerId: ProviderId;
  readonly tier: SourceTier;
  /**
   * Der Zeitstempel des ANBIETERS. `null`, wenn er keinen liefert.
   *
   * Pflichtfeld und ausdruecklich nicht optional: wer eine Quelle anbindet,
   * muss sagen, ob sie ein Datenalter mitliefert. Ein weglassbares Feld waere
   * hier ein stiller Weg zu `freshnessSeconds: 0`.
   */
  readonly providerObservedAt: Date | null;
  readonly fetchedAt: Date;
}): Sourced<T> {
  const { providerObservedAt, ...rest } = input;
  return {
    ...rest,
    observedAt: providerObservedAt ?? input.fetchedAt,
    freshnessSeconds:
      providerObservedAt === null
        ? null
        : Math.max(0, (input.fetchedAt.getTime() - providerObservedAt.getTime()) / 1_000),
  };
}

export interface Contributor {
  readonly providerId: ProviderId;
  readonly tier: SourceTier;
  /** `null`, wenn dieser Beitraeger kein Datenalter mitliefert. */
  readonly freshnessSeconds: number | null;
}

/**
 * Ein aus mehreren Quellen zusammengesetzter Wert.
 *
 * Es gibt bewusst KEINE Funktion, die zwei `Sourced`-Werte zu einem `Sourced`
 * verschmilzt. Wer Felder aus zwei Anbietern kombiniert, bekommt einen
 * `MultiSourced`, und der traegt die **schlechteste** Stufe und die **aelteste**
 * Beobachtung aller Beteiligten.
 *
 * Der Grund: ein Datensatz, in dem der Preis vom Primaeranbieter und die
 * Liquiditaet vom Fallback stammt, ist kein Primaerdatensatz. Ihn als solchen zu
 * fuehren waere genau die stille Qualitaetsvermischung, die spaeter niemand mehr
 * aufloesen kann.
 */
export interface MultiSourced<T> {
  readonly value: T;
  readonly contributors: readonly Contributor[];
  readonly effectiveTier: SourceTier;
  /** `null`, sobald auch nur ein Beitraeger kein Datenalter mitliefert. */
  readonly effectiveFreshnessSeconds: number | null;
}

export function combineSources<T>(
  value: T,
  parts: readonly Sourced<unknown>[],
): MultiSourced<T> {
  if (parts.length === 0) {
    throw new TypeError("Ein zusammengesetzter Wert braucht mindestens eine Quelle");
  }
  const contributors: Contributor[] = parts.map((p) => ({
    providerId: p.providerId,
    tier: p.tier,
    freshnessSeconds: p.freshnessSeconds,
  }));
  return {
    value,
    contributors,
    effectiveTier: contributors.reduce<SourceTier>(
      (worst, c) => worseTier(worst, c.tier),
      "PRIMARY",
    ),
    // Das schlechteste Alter zaehlt — und „unbekannt" ist schlechter als jede
    // Zahl. Ein Datensatz, dessen eine Haelfte beliebig alt sein koennte, ist
    // nicht so frisch wie seine juengere Haelfte. `Math.max` mit einem `null`
    // darin haette hier stillschweigend 0 ergeben.
    effectiveFreshnessSeconds: contributors.some((c) => c.freshnessSeconds === null)
      ? null
      : Math.max(...contributors.map((c) => c.freshnessSeconds ?? 0)),
  };
}

/* ---------------------------------------------------------- Fallback-Kette */

export interface ChainMember<P> {
  readonly provider: P;
  readonly providerId: ProviderId;
  readonly tier: SourceTier;
  status(): ProviderStatus;
}

export interface ChainAttempt {
  readonly providerId: ProviderId;
  readonly tier: SourceTier;
  readonly outcome: "SKIPPED_STATUS" | "NO_DATA" | "ERROR" | "OK";
  readonly detail: string | null;
}

export type ChainResult<T> =
  | { readonly kind: "OK"; readonly data: Sourced<T>; readonly attempts: readonly ChainAttempt[] }
  | { readonly kind: "NO_SOURCE"; readonly attempts: readonly ChainAttempt[]; readonly reason: string };

/**
 * Fragt die Kette der Reihe nach.
 *
 * Der erste Anbieter, der Daten liefert, gewinnt — und das Ergebnis traegt
 * seine Stufe. Es wird nichts gemittelt und nichts erganzt: entweder ein
 * Anbieter beantwortet die Frage, oder die Kette meldet, dass niemand sie
 * beantwortet hat.
 *
 * `NO_SOURCE` ist ein regulaeres Ergebnis und keine Ausnahme. Genau das ist der
 * Zustand, in dem sich dieses System gerade befindet.
 */
export async function resolveFromChain<P, T>(input: {
  readonly members: readonly ChainMember<P>[];
  /**
   * `observedAt` ist der Zeitstempel des ANBIETERS und darf `null` sein —
   * nicht jede Quelle liefert einen. Der Abrufzeitpunkt wird NICHT hier
   * eingesetzt; das entscheidet `sourced()` an einer Stelle statt an jeder.
   */
  readonly fetch: (provider: P) => Promise<{ value: T; observedAt: Date | null } | null>;
  readonly clock: Clock;
  /** Ob auch DEGRADED-Anbieter gefragt werden duerfen. */
  readonly allowDegraded?: boolean;
}): Promise<ChainResult<T>> {
  const attempts: ChainAttempt[] = [];
  const allowDegraded = input.allowDegraded ?? true;

  for (const member of input.members) {
    const status = member.status();
    const usable = allowDegraded ? statusAllowsUse(status) : statusAllowsEntryDecision(status);
    if (!usable) {
      attempts.push({
        providerId: member.providerId,
        tier: member.tier,
        outcome: "SKIPPED_STATUS",
        detail: status,
      });
      continue;
    }

    try {
      const result = await input.fetch(member.provider);
      if (result === null) {
        attempts.push({
          providerId: member.providerId,
          tier: member.tier,
          outcome: "NO_DATA",
          detail: null,
        });
        continue;
      }
      attempts.push({
        providerId: member.providerId,
        tier: member.tier,
        outcome: "OK",
        detail: null,
      });
      return {
        kind: "OK",
        data: sourced({
          value: result.value,
          providerId: member.providerId,
          tier: member.tier,
          providerObservedAt: result.observedAt,
          fetchedAt: input.clock.now(),
        }),
        attempts,
      };
    } catch (error: unknown) {
      attempts.push({
        providerId: member.providerId,
        tier: member.tier,
        outcome: "ERROR",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    kind: "NO_SOURCE",
    attempts,
    reason:
      attempts.length === 0
        ? "Kein Anbieter in der Kette konfiguriert."
        : `Kein Anbieter lieferte Daten (${attempts.map((a) => `${a.providerId}:${a.outcome}`).join(", ")}).`,
  };
}
