import { isBase58Address, providerId, type Clock, type ProviderId } from "@sae/core";

import { classifyFailure, type FailureClass } from "../capability";
import { zodContract, type ContractResult, type ResponseContract } from "../contract";
import {
  dexScreenerProfilesResponseSchema,
  SOLANA_CHAIN_ID,
  type DexScreenerProfileRaw,
} from "./profiles-schema";

/**
 * Der Kandidatenstrom: welche Token gibt es ueberhaupt neu?
 *
 * Das fehlende Stueck der Discovery. Sieb, Deduplizierung und Bewertung waren
 * seit Langem gebaut und getestet — es kam nur nie etwas an, weil niemand
 * `DiscoverySource` implementiert hatte.
 *
 * Diese Datei liefert **Kandidaten, keine Urteile**. Der Profil-Strom von
 * DexScreener enthaelt nachweislich keine Marktdaten (siehe
 * `profiles-schema.ts`); was hier herauskommt, ist eine Liste von Adressen mit
 * Herkunftsvermerk. Ob eines davon handelbar ist, entscheidet dieselbe Kette
 * wie fuer jeden anderen Token: Anreicherung, Vorsieb, Marktauswahl,
 * Qualitaetsgate.
 */

export const DEXSCREENER_PROFILES_ENDPOINT = "/token-profiles/latest/v1";

/** Ein Token, den der Strom gemeldet hat — mehr weiss diese Ebene nicht. */
export interface DexScreenerProfile {
  readonly mint: string;
  /** Marketingtext des Einreichers. Ausdruecklich KEIN Signal. */
  readonly description: string | null;
  /** Verlinkte Kanaele. Ihre Existenz sagt nichts ueber Echtheit. */
  readonly links: readonly string[];
}

/**
 * Der geprüfte Vertrag.
 *
 * `verified: true`, abgeleitet aus einer echten Antwort vom 2026-09-06.
 *
 * Die Umwandlung filtert hier bereits auf Solana und verwirft Adressen, die
 * keine Base58-Adresse sind. Beides gehoert in die Validierung und nicht in
 * die Fehlerbehandlung: eine EVM-Adresse aus dem Mischstrom ist kein Fehler,
 * sondern ein Eintrag fuer eine andere Kette.
 */
export const DEXSCREENER_PROFILES_CONTRACT: ResponseContract<readonly DexScreenerProfile[]> =
  zodContract({
    schema: dexScreenerProfilesResponseSchema.transform((entries) =>
      entries
        .filter((e: DexScreenerProfileRaw) => e.chainId === SOLANA_CHAIN_ID)
        .filter((e: DexScreenerProfileRaw) => isBase58Address(e.tokenAddress))
        .map(
          (e: DexScreenerProfileRaw): DexScreenerProfile => ({
            mint: e.tokenAddress,
            description: e.description ?? null,
            links: (e.links ?? []).map((l) => l.url),
          }),
        ),
    ),
    schemaVersion: "dexscreener-token-profiles-v1@2026-09-06",
    verified: true,
  });

export type ProfilesFetchOutcome =
  | { readonly kind: "OK"; readonly profiles: readonly DexScreenerProfile[]; readonly latencyMs: number; readonly httpStatus: number }
  | { readonly kind: "SCHEMA_REJECTED"; readonly reason: string; readonly latencyMs: number; readonly httpStatus: number }
  | {
      readonly kind: "FAILED";
      readonly failure: FailureClass;
      readonly reason: string;
      readonly latencyMs: number;
      readonly httpStatus: number | null;
    };

export const DEXSCREENER_PROFILES_PROVIDER_ID: ProviderId = providerId("dexscreener");

export interface ProfilesDeps {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly contract?: ResponseContract<readonly DexScreenerProfile[]>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_BASE_URL = "https://api.dexscreener.com";

/**
 * Holt den Kandidatenstrom.
 *
 * Kein Retry — die Wiederholung gehoert in den Consumer, der sie mit Backoff
 * und Dead Letter fuehrt. Zwei Schleifen uebereinander multiplizieren sich, und
 * das faellt erst bei einem Ausfall auf.
 */
export class DexScreenerProfilesAdapter {
  readonly providerId = DEXSCREENER_PROFILES_PROVIDER_ID;
  readonly #deps: ProfilesDeps;
  readonly #contract: ResponseContract<readonly DexScreenerProfile[]>;

  constructor(deps: ProfilesDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? DEXSCREENER_PROFILES_CONTRACT;
  }

  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  get schemaVersion(): string {
    return this.#contract.schemaVersion;
  }

  url(): string {
    return `${this.#deps.baseUrl ?? DEFAULT_BASE_URL}${DEXSCREENER_PROFILES_ENDPOINT}`;
  }

  async fetchProfiles(): Promise<ProfilesFetchOutcome> {
    const { clock } = this.#deps;
    const startedAt = clock.now().getTime();
    const elapsed = (): number => Math.max(0, clock.now().getTime() - startedAt);

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(this.url(), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      body = await response.text();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "FAILED",
        failure: classifyFailure({ message, errorCode: errorCodeOf(error) }),
        reason: message,
        latencyMs: elapsed(),
        httpStatus: null,
      };
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = elapsed();

    if (!response.ok) {
      return {
        kind: "FAILED",
        failure: classifyFailure({ httpStatus: response.status, message: body.slice(0, 200) }),
        reason: `HTTP ${String(response.status)}: ${body.slice(0, 200)}`,
        latencyMs,
        httpStatus: response.status,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return {
        kind: "SCHEMA_REJECTED",
        reason: "Antwort ist kein gueltiges JSON.",
        latencyMs,
        httpStatus: response.status,
      };
    }

    const validated: ContractResult<readonly DexScreenerProfile[]> = this.#contract.validate(raw);
    if (validated.kind !== "VALID") {
      return {
        kind: "SCHEMA_REJECTED",
        reason: validated.reason,
        latencyMs,
        httpStatus: response.status,
      };
    }

    return { kind: "OK", profiles: validated.value, latencyMs, httpStatus: response.status };
  }
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    if ("name" in error && (error as { name: unknown }).name === "AbortError") return "ETIMEDOUT";
    if ("code" in error) return String((error as { code: unknown }).code);
  }
  return null;
}
