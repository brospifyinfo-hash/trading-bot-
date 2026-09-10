import { isBase58Address, providerId, type Clock, type ProviderId } from "@sae/core";
import { describeShape } from "@sae/observability";

import { classifyFailure, type FailureClass } from "../capability";
import { zodContract, type ContractResult, type ResponseContract } from "../contract";
import {
  MINT_ACCOUNT_TYPE,
  SPL_TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  solanaAccountInfoResultSchema,
} from "./mint-schema";

/**
 * Der Mint-Account: wer darf nachpraegen, wer darf einfrieren?
 *
 * Die Luecke, die dieser Adapter schliessen soll, steht in DECISIONS §87:
 * `cheapScreen` prueft Mint- und Freeze-Authority, bekommt sie aber nie zu
 * sehen, weil es kein Lesemodul gab. Und `cheapScreen` lehnt bei UNBEKANNT
 * nicht ab — ein beliebig nachpraegbarer Token kommt also durch das Vorsieb.
 *
 * ### Was dieser Adapter ausdruecklich NICHT loest
 *
 * **Das Datenalter der Marktdaten.** Ich hatte das zwischenzeitlich anders
 * dargestellt, und das war falsch. Ein RPC-Aufruf sagt, was JETZT on-chain
 * steht — er sagt nichts darueber, wann DexScreener seinen Preis gemessen hat.
 * Diesen Zeitstempel an fremde Marktdaten zu heften waere dieselbe Erfindung,
 * die §89 aus der Frische-Berechnung entfernt hat, nur mit mehr Aufwand.
 *
 * Ein ehrlicher Preis mit bekanntem Alter entsteht erst, wenn wir die
 * Pool-Reserven SELBST von der Kette lesen — dann traegt der Wert unseren
 * eigenen Slot. Das ist ein eigenes, groesseres Stueck Arbeit und nicht dieses
 * hier.
 *
 * ### Warum der Vertrag ungeprueft ist
 *
 * Aus dieser Arbeitsumgebung ist kein Solana-RPC erreichbar. Der Adapter ist
 * vollstaendig lauffaehig, lehnt aber jede Antwort mit `SCHEMA_UNVERIFIED` ab,
 * bis eine echte Antwort den Vertrag belegt. Siehe `mint-schema.ts`.
 */

export const SOLANA_RPC_PROVIDER_ID: ProviderId = providerId("solana-rpc");
export const GET_ACCOUNT_INFO = "getAccountInfo";

/** Was wir ueber einen Mint wissen, nachdem wir ihn selbst gelesen haben. */
export interface MintAccount {
  readonly mint: string;
  /** Aktiv = jemand kann beliebig nachpraegen. */
  readonly mintAuthorityActive: boolean;
  /** Aktiv = jemand kann fremde Konten einfrieren. */
  readonly freezeAuthorityActive: boolean;
  readonly decimals: number;
  /** Roh, als Text: u64 passt nicht verlustfrei in eine JSON-Zahl. */
  readonly supplyRaw: string;
  /** Der Slot, zu dem das RPC geantwortet hat. UNSER Zeitanker fuer diesen Wert. */
  readonly slot: number;
  /** Token-2022 kann Erweiterungen tragen, die Token nicht hat. */
  readonly tokenProgram: string;
}

/**
 * Der Vertrag — noch ohne Beleg.
 *
 * `needed` beschreibt, was fehlt, damit jemand ohne Kenntnis dieses Codes
 * weiss, was zu tun ist.
 */
/**
 * Der geprüfte Vertrag.
 *
 * `verified: true`, abgeleitet aus einer echten Antwort vom 2026-09-10 —
 * gemessen vom laufenden Worker gegen den konfigurierten RPC-Endpunkt, nicht
 * aus der Dokumentation abgeschrieben.
 *
 * Gegen die Vermutung bestaetigt: `result.context.slot`,
 * `result.value.data.parsed.type`, `result.value.data.parsed.info` mit
 * `decimals`, `supply`, `isInitialized`, `mintAuthority`, `freezeAuthority`,
 * dazu `result.value.owner`.
 *
 * Die Antwort traegt mehr, als das Schema nennt — `apiVersion`, `lamports`,
 * `rentEpoch`, `space`, ein `id` auf oberster Ebene. `passthrough()` laesst
 * sie durch, statt an ihnen zu scheitern: ein Anbieter, der ein Feld
 * ERGAENZT, hat nichts gebrochen.
 */
export const SOLANA_MINT_CONTRACT: ResponseContract<MintAccountData | null> = zodContract({
  schema: solanaAccountInfoResultSchema.transform(toMintAccountData),
  schemaVersion: "solana-getaccountinfo-mint-v1@2026-09-10",
  verified: true,
});

/**
 * Was in der Antwort steht — ohne die Adresse.
 *
 * `getAccountInfo` liefert den Kontoinhalt, nicht die abgefragte Adresse. Der
 * Vertrag kann sie also gar nicht kennen; nur der Aufrufer weiss, wonach er
 * gefragt hat. Sie hier mit einem Platzhalter zu fuellen und spaeter zu
 * ueberschreiben waere ein leerer Wert, der eine Weile mitlaeuft — genau die
 * Sorte, die irgendwann nicht ueberschrieben wird.
 */
export type MintAccountData = Omit<MintAccount, "mint">;

export type MintFetchOutcome =
  | { readonly kind: "OK"; readonly account: MintAccount | null; readonly latencyMs: number }
  /** Antwort kam an, taugt aber nicht — inklusive „noch kein Vertrag". */
  | {
      readonly kind: "SCHEMA_REJECTED";
      readonly reason: string;
      readonly latencyMs: number;
      /**
       * Die FORM der Antwort — Schluesselpfade und Typen, keine Werte.
       *
       * Eine Ablehnung, die nicht sagt, was stattdessen kam, zwingt jeden
       * dazu, den Anbieter selbst aufzurufen. Genau das ist hier nicht immer
       * moeglich: aus der Entwicklungsumgebung ist kein Solana-RPC
       * erreichbar, wohl aber aus dem laufenden Worker. Die Form im Log ist
       * damit der Weg, wie ein ungeprueftes Schema zu einem geprueften wird —
       * ohne dass jemand eine Antwort abtippt und ohne dass Werte im Log
       * landen.
       */
      readonly shape: string;
    }
  /** Das RPC selbst hat einen Fehler gemeldet — mit HTTP 200. */
  | { readonly kind: "RPC_ERROR"; readonly code: number; readonly message: string; readonly latencyMs: number }
  | {
      readonly kind: "FAILED";
      readonly failure: FailureClass;
      readonly reason: string;
      readonly latencyMs: number;
      readonly httpStatus: number | null;
      /**
       * Ob das eigene Zeitlimit zugeschlagen hat.
       *
       * `FailureClass` kennt keinen Timeout, und aus der Fehlermeldung darauf
       * zu schliessen waere Textraten ueber Laufzeitgrenzen hinweg. Der
       * Adapter haelt den AbortController selbst — er weiss es sicher, also
       * sagt er es auch.
       */
      readonly timedOut: boolean;
    };

export interface SolanaMintDeps {
  readonly clock: Clock;
  readonly rpcUrl: string;
  readonly contract?: ResponseContract<MintAccountData | null>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class SolanaMintAdapter {
  readonly providerId = SOLANA_RPC_PROVIDER_ID;
  readonly #deps: SolanaMintDeps;
  readonly #contract: ResponseContract<MintAccountData | null>;

  constructor(deps: SolanaMintDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? SOLANA_MINT_CONTRACT;
  }

  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  get schemaVersion(): string {
    return this.#contract.schemaVersion;
  }

  /** Der Rumpf der Anfrage — oeffentlich, damit ein Test ihn pruefen kann. */
  body(mint: string): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: GET_ACCOUNT_INFO,
      // `jsonParsed` laesst das RPC die Kontodaten auslegen. Die Alternative
      // waere base64 plus eigenes Byte-Parsing des Mint-Layouts — mehr Code,
      // mehr Gelegenheiten fuer einen Versatzfehler, und ein Versatzfehler
      // hiesse hier: falsche Autoritaet, also falsche Sicherheitsaussage.
      params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
    });
  }

  async fetchMint(mint: string): Promise<MintFetchOutcome> {
    const { clock } = this.#deps;
    const startedAt = clock.now().getTime();
    const elapsed = (): number => Math.max(0, clock.now().getTime() - startedAt);

    if (!isBase58Address(mint)) {
      // Keine Anfrage fuer etwas, das keine Adresse ist. Das RPC wuerde sie mit
      // einem Fehler beantworten, und der saehe aus wie ein Ausfall.
      return { kind: "SCHEMA_REJECTED", reason: "Keine Solana-Adresse.", latencyMs: 0, shape: "" };
    }

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    let raw: string;
    try {
      response = await fetchImpl(this.#deps.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: this.body(mint),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "FAILED",
        failure: classifyFailure({ message }),
        reason: message,
        latencyMs: elapsed(),
        httpStatus: null,
        timedOut: controller.signal.aborted,
      };
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = elapsed();

    if (!response.ok) {
      return {
        kind: "FAILED",
        failure: classifyFailure({ httpStatus: response.status, message: raw.slice(0, 200) }),
        reason: `HTTP ${String(response.status)}: ${raw.slice(0, 200)}`,
        latencyMs,
        httpStatus: response.status,
        timedOut: false,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        kind: "SCHEMA_REJECTED",
        reason: "Antwort ist kein gueltiges JSON.",
        latencyMs,
        shape: "",
      };
    }

    // Der Fehlerast ZUERST und vor dem Vertrag: ein JSON-RPC-Fehler kommt mit
    // HTTP 200, und wer nur `response.ok` prueft, haelt "Account not found"
    // fuer einen Erfolg.
    const asError = solanaRpcErrorLike(parsed);
    if (asError !== null) {
      return { kind: "RPC_ERROR", code: asError.code, message: asError.message, latencyMs };
    }

    const validated: ContractResult<MintAccountData | null> = this.#contract.validate(parsed);
    if (validated.kind !== "VALID") {
      return {
        kind: "SCHEMA_REJECTED",
        reason: validated.reason,
        latencyMs,
        shape: describeShape(parsed),
      };
    }
    // Die Adresse kommt vom Aufrufer, weil sie nicht in der Antwort steht.
    const account = validated.value === null ? null : { mint, ...validated.value };
    return { kind: "OK", account, latencyMs };
  }
}

/**
 * Wandelt eine geprueft gueltige Antwort in unser Bild um.
 *
 * Getrennt von der Klasse, damit der Vertrag sie beim Umstellen auf
 * `zodContract` als Transformation benutzen kann — ohne dass die Umwandlung an
 * zwei Stellen steht und auseinanderlaeuft.
 */
export function toMintAccountData(raw: unknown): MintAccountData | null {
  // Ausdruecklich gegen den ERFOLGSAST und nicht gegen die Union: `passthrough()`
  // gibt jedem Ast eine Index-Signatur, und damit grenzt `"result" in x` die
  // Union nicht ein. Der Fehlerast ist eine Zeile vorher schon behandelt.
  const result = solanaAccountInfoResultSchema.safeParse(raw);
  if (!result.success) return null;

  const { context, value } = result.data.result;
  // Die Adresse traegt keinen Account. Das ist eine Auskunft, kein Fehler.
  if (value === null) return null;

  // Ein Token-Account hat dieselbe aeussere Form wie ein Mint. Ihn als Mint zu
  // lesen ergaebe Autoritaeten, die es nicht gibt.
  if (value.data.parsed.type !== MINT_ACCOUNT_TYPE) return null;
  if (value.owner !== SPL_TOKEN_PROGRAM_ID && value.owner !== SPL_TOKEN_2022_PROGRAM_ID) {
    return null;
  }

  const info = value.data.parsed.info;
  return {
    // `null` heisst ausdruecklich „abgegeben" und ist die gute Nachricht.
    mintAuthorityActive: info.mintAuthority !== null,
    freezeAuthorityActive: info.freezeAuthority !== null,
    decimals: info.decimals,
    supplyRaw: info.supply,
    slot: context.slot,
    tokenProgram: value.owner,
  };
}

function solanaRpcErrorLike(value: unknown): { code: number; message: string } | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = (value as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (typeof code !== "number" || typeof message !== "string") return null;
  return { code, message };
}
