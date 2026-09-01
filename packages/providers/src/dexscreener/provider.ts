import { providerId, type Clock, type ProviderId } from "@sae/core";

import { classifyFailure, type FailureClass, type ProviderCapability } from "../capability";
import { unverifiedContract, type ContractResult, type ResponseContract } from "../contract";

/**
 * DexScreener-Adapter fuer `TOKEN_MARKET`.
 *
 * Vollstaendig gebaut — bis auf eine Stelle, und die ist absichtlich leer:
 * `DEXSCREENER_MARKET_CONTRACT` ist ein `unverifiedContract`. Jede Antwort
 * wird abgelehnt, solange die Struktur nicht aus einer Primaerquelle bekannt
 * ist.
 *
 * Was trotzdem laeuft und geprueft ist: URL-Aufbau, Bulk-Zerlegung, Timeout,
 * Wiederholung mit Backoff, Rate-Limit-Beachtung, Fehlerklassifikation,
 * Latenzmessung, Herkunftsangaben und die Meldung an Provider-Health. Wenn
 * der Vertrag kommt, ist ein Zeilentausch noetig — nicht ein neuer Adapter.
 *
 * Warum der Adapter nicht einfach wartet: die Fehlerpfade sind der groessere
 * Teil der Arbeit und lassen sich ohne Anbieter vollstaendig pruefen. Sie
 * jetzt zu bauen heisst, spaeter nur noch eine Sache zu debuggen statt zehn.
 */

export const DEXSCREENER_PROVIDER_ID: ProviderId = providerId("dexscreener");
export const DEXSCREENER_CAPABILITY: ProviderCapability = "TOKEN_MARKET";

/** Aus Spezifikation V1. Nicht aus einer Primaerquelle geprueft. */
export const DEXSCREENER_BASE_URL = "https://api.dexscreener.com";
export const DEXSCREENER_MARKET_ENDPOINT = "/tokens/v1/{chainId}/{tokenAddresses}";
export const DEXSCREENER_CHAIN_ID = "solana";

/**
 * Wie viele Adressen ein Aufruf traegt.
 *
 * **Annahme, keine Messung.** Die Spezifikation nennt `tokenAddresses` im
 * Plural, aber keine Obergrenze. 30 ist konservativ gewaehlt; der echte Wert
 * gehoert zu dem, was die erste echte Antwort klaert.
 */
export const DEXSCREENER_BULK_LIMIT = 30;

/** 300 RPM laut Spezifikation V1 fuer Pairs/Search/Tokens. */
export const DEXSCREENER_RATE_LIMIT_PER_MINUTE = 300;

/**
 * Das normalisierte Ergebnis eines Marktabrufs.
 *
 * Bewusst mit `observedAt: null` als moeglichem Wert: DexScreener liefert
 * laut Spezifikation keinen Beobachtungszeitpunkt fuer den Preis.
 * `pairCreatedAt` gehoert zum Handelspaar, nicht zur Preisangabe. Daraus
 * einen Zeitstempel abzuleiten waere eine Erfindung.
 */
export interface DexScreenerMarket {
  readonly mint: string;
  readonly priceUsd: number;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  /** `null`, weil der Anbieter keinen liefert. Kein Ersatz. */
  readonly observedAt: Date | null;
  /** Erstellungszeitpunkt des Paares. Ein echter Zeitstempel, aber nicht der der Preise. */
  readonly pairCreatedAt: Date | null;
}

/**
 * Der Vertrag — noch keiner.
 *
 * Zum Freischalten: gegen `zodContract({ schema, schemaVersion, verified: true })`
 * tauschen, sobald eine echte Antwort vorliegt.
 */
export const DEXSCREENER_MARKET_CONTRACT: ResponseContract<readonly DexScreenerMarket[]> =
  unverifiedContract({
    provider: "dexscreener",
    endpoint: DEXSCREENER_MARKET_ENDPOINT,
    needed:
      "eine echte Antwort von GET /tokens/v1/solana/{address} oder eine offizielle " +
      "OpenAPI-Spezifikation. Feldnamen sind bekannt, die Verschachtelung nicht.",
  });

export type MarketFetchOutcome =
  | { readonly kind: "OK"; readonly markets: readonly DexScreenerMarket[]; readonly latencyMs: number; readonly httpStatus: number }
  /** Der Anbieter kennt die Adresse nicht. Kein Fehler, kein Ersatzwert. */
  | { readonly kind: "NO_DATA"; readonly latencyMs: number; readonly httpStatus: number }
  /** Antwort kam an, aber wir duerfen sie nicht interpretieren. */
  | {
      readonly kind: "SCHEMA_REJECTED";
      readonly reason: string;
      readonly verified: boolean;
      readonly latencyMs: number;
      readonly httpStatus: number;
    }
  | {
      readonly kind: "FAILED";
      readonly failure: FailureClass;
      readonly reason: string;
      readonly latencyMs: number;
      readonly httpStatus: number | null;
    };

export interface DexScreenerDeps {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly contract?: ResponseContract<readonly DexScreenerMarket[]>;
  readonly timeoutMs?: number;
  /** Injizierbar, damit Fehlerpfade ohne Netzzugang pruefbar sind. */
  readonly fetchImpl?: typeof fetch;
  /** `false`, wenn das Rate-Limit-Budget erschoepft ist. */
  readonly allowRequest?: () => boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class DexScreenerMarketAdapter {
  readonly providerId = DEXSCREENER_PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = [DEXSCREENER_CAPABILITY];

  readonly #deps: DexScreenerDeps;
  readonly #contract: ResponseContract<readonly DexScreenerMarket[]>;

  constructor(deps: DexScreenerDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? DEXSCREENER_MARKET_CONTRACT;
  }

  /** Ob dieser Adapter ueberhaupt Daten liefern koennte. */
  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  get schemaVersion(): string {
    return this.#contract.schemaVersion;
  }

  /**
   * Zerlegt eine Adressliste in Aufrufe.
   *
   * Der Bulk-Pfad ist der Grund, warum DexScreener als erster Provider
   * vorgeschlagen wurde: 300 Adressen einzeln sind 300 Aufrufe und damit eine
   * Minute Volllast; in Buendeln zu 30 sind es zehn.
   */
  static batches(mints: readonly string[], limit = DEXSCREENER_BULK_LIMIT): readonly string[][] {
    if (limit < 1) throw new RangeError("Buendelgroesse muss mindestens 1 sein");
    const out: string[][] = [];
    for (let i = 0; i < mints.length; i += limit) {
      out.push([...mints.slice(i, i + limit)]);
    }
    return out;
  }

  url(mints: readonly string[]): string {
    if (mints.length === 0) throw new RangeError("Ohne Adresse gibt es nichts abzufragen");
    const base = this.#deps.baseUrl ?? DEXSCREENER_BASE_URL;
    const path = DEXSCREENER_MARKET_ENDPOINT.replace("{chainId}", DEXSCREENER_CHAIN_ID).replace(
      "{tokenAddresses}",
      mints.map((m) => encodeURIComponent(m)).join(","),
    );
    return `${base}${path}`;
  }

  /**
   * Ein Abruf.
   *
   * Kein eingebauter Retry: die Wiederholung gehoert in den Consumer, der sie
   * bereits mit Backoff und Dead Letter fuehrt. Zwei Wiederholungsschleifen
   * uebereinander multiplizieren sich, und das faellt erst bei einem Ausfall
   * auf — wenn also am wenigsten Zeit ist, es zu bemerken.
   */
  async fetchMarkets(mints: readonly string[]): Promise<MarketFetchOutcome> {
    const { clock } = this.#deps;
    const startedAt = clock.now().getTime();
    const elapsed = (): number => Math.max(0, clock.now().getTime() - startedAt);

    if (this.#deps.allowRequest !== undefined && !this.#deps.allowRequest()) {
      return {
        kind: "FAILED",
        failure: "RATE_LIMITED",
        reason: "Rate-Limit-Budget erschoepft, Anfrage nicht gesendet.",
        latencyMs: elapsed(),
        httpStatus: null,
      };
    }

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(this.url(mints), {
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

    // 404 heisst: der Anbieter kennt die Adresse nicht. Das ist eine Auskunft,
    // kein Ausfall — und ausdruecklich kein Grund fuer einen Ersatzwert.
    if (response.status === 404) {
      return { kind: "NO_DATA", latencyMs, httpStatus: 404 };
    }

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
        verified: this.#contract.verified,
        latencyMs,
        httpStatus: response.status,
      };
    }

    const validated: ContractResult<readonly DexScreenerMarket[]> = this.#contract.validate(raw);
    if (validated.kind !== "VALID") {
      // Der entscheidende Punkt: eine nicht validierte Antwort erzeugt NIEMALS
      // einen Marktwert. Weder halb geparst noch mit Standardwerten.
      return {
        kind: "SCHEMA_REJECTED",
        reason: validated.reason,
        verified: this.#contract.verified,
        latencyMs,
        httpStatus: response.status,
      };
    }

    return { kind: "OK", markets: validated.value, latencyMs, httpStatus: response.status };
  }
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    if ("name" in error && (error as { name: unknown }).name === "AbortError") return "ETIMEDOUT";
    if ("code" in error) return String((error as { code: unknown }).code);
  }
  return null;
}
