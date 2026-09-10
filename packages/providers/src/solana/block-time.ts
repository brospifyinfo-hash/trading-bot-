import type { Clock } from "@sae/core";
import { describeShape } from "@sae/observability";
import { z } from "zod";

import { classifyFailure, type FailureClass } from "../capability";
import { zodContract, type ContractResult, type ResponseContract } from "../contract";

/**
 * `getBlockTime` — aus einem Slot wird eine echte Uhrzeit.
 *
 * Das Bindeglied, ohne das ein `contextSlot` nur eine Zahl ist. Ein Quote sagt
 * „gerechnet zu Slot 300_000_000"; erst diese Abfrage sagt, wann das war.
 *
 * ### Warum nicht rechnen statt fragen
 *
 * Solana zielt auf 400 ms je Slot, und daraus liesse sich ein Alter schaetzen.
 * Genau das ist der Unterschied, um den es in diesem System geht: eine
 * Schaetzung mit einem angenommenen Takt ist keine Messung. Slots fallen aus,
 * die Netzlast schwankt, und die Abweichung waechst mit dem Abstand. Ein
 * geschaetztes Alter, das in die Frischepruefung geht, ist ein erfundener Wert
 * mit besserer Tarnung — dieselbe Klasse Fehler wie in DECISIONS §89.
 *
 * ### Antwortform
 *
 * `result` ist eine Unix-Zeit in **Sekunden**, oder `null`, wenn der Slot nicht
 * (mehr) verfuegbar ist — etwa weil er aelter ist als die Aufbewahrung des
 * Knotens. `null` ist damit eine Auskunft und kein Fehler.
 */

export const GET_BLOCK_TIME = "getBlockTime";

export const blockTimeResultSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    /** Unix-Sekunden, oder null wenn der Slot nicht verfuegbar ist. */
    result: z.number().int().nullable(),
  })
  .passthrough();

/**
 * Der geprüfte Vertrag.
 *
 * `verified: true`, abgeleitet aus einer echten Antwort vom 2026-09-10 —
 * gemessen von der Sonde im provider-health-Takt, nicht aus der Spezifikation
 * abgeschrieben. Die gemessene Form war
 * `id:number · jsonrpc:string · result:number`, und `result` trug eine Zahl in
 * der Groessenordnung der Unix-Sekunden.
 *
 * Damit ist die letzte offene Stelle der Kette geschlossen: ein Quote nennt
 * seinen `contextSlot`, dieser Vertrag macht daraus eine Uhrzeit, und aus der
 * Uhrzeit wird ein echtes Datenalter (DECISIONS §96/§97). Kein geschaetzter
 * 400-ms-Takt, keine ersetzte eigene Uhr.
 *
 * `passthrough()` laesst `id` und alles weitere stehen, statt daran zu
 * scheitern — ein RPC, das ein Feld ERGAENZT, hat nichts gebrochen.
 */
export const SOLANA_BLOCK_TIME_CONTRACT: ResponseContract<Date | null> = zodContract({
  schema: blockTimeResultSchema.transform(toBlockTimeFromParsed),
  schemaVersion: "solana-getblocktime-v1@2026-09-10",
  verified: true,
});

export type BlockTimeOutcome =
  | { readonly kind: "OK"; readonly at: Date | null; readonly latencyMs: number }
  | { readonly kind: "SCHEMA_REJECTED"; readonly reason: string; readonly shape: string }
  | { readonly kind: "RPC_ERROR"; readonly code: number; readonly message: string }
  | { readonly kind: "FAILED"; readonly failure: FailureClass; readonly reason: string };

/**
 * Wandelt eine geprueft gueltige Antwort um.
 *
 * Unix-**Sekunden**, nicht Millisekunden. Der Unterschied ist Faktor 1000 und
 * ergaebe ein Datum im Jahr 1970 oder im Jahr 56000 — beides faellt auf. Der
 * gefaehrlichere Fall waere ein Alter, das um Faktor 1000 danebenliegt und
 * trotzdem plausibel aussieht, deshalb steht die Einheit hier ausgeschrieben.
 */
export function toBlockTime(raw: unknown): Date | null {
  const parsed = blockTimeResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return toBlockTimeFromParsed(parsed.data);
}

/**
 * Derselbe Schritt, aber auf einer bereits geprueften Antwort.
 *
 * Getrennt, weil der Vertrag ihn als `transform` braucht: dort ist die Antwort
 * schon validiert, und ein zweites `safeParse` darin koennte einen
 * Schemafehler in ein stilles `null` verwandeln — also genau die
 * Unterscheidung einebnen, fuer die es `INVALID` gegen `VALID` gibt.
 */
function toBlockTimeFromParsed(parsed: z.infer<typeof blockTimeResultSchema>): Date | null {
  const seconds = parsed.result;
  if (seconds === null) return null;
  return new Date(seconds * 1_000);
}

export interface BlockTimeDeps {
  /**
   * Die Uhr ist eine Abhaengigkeit, weil die Latenz eine Messung ist.
   *
   * Vorher stand hier `latencyMs: 0` — eine erfundene Kennzahl, dieselbe
   * Klasse Fehler wie das erfundene Datenalter in DECISIONS §89. Sie waere in
   * die Provider-Health gewandert und haette diesen Abruf als den schnellsten
   * im System ausgewiesen.
   */
  readonly clock: Clock;
  readonly rpcUrl: string;
  readonly contract?: ResponseContract<Date | null>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class SolanaBlockTimeAdapter {
  readonly #deps: BlockTimeDeps;
  readonly #contract: ResponseContract<Date | null>;

  constructor(deps: BlockTimeDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? SOLANA_BLOCK_TIME_CONTRACT;
  }

  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  body(slot: number): string {
    return JSON.stringify({ jsonrpc: "2.0", id: 1, method: GET_BLOCK_TIME, params: [slot] });
  }

  async fetchBlockTime(slot: number): Promise<BlockTimeOutcome> {
    if (!Number.isInteger(slot) || slot < 0) {
      return { kind: "SCHEMA_REJECTED", reason: "Kein gueltiger Slot.", shape: "" };
    }

    const startedAt = this.#deps.clock.now().getTime();
    const elapsed = (): number => Math.max(0, this.#deps.clock.now().getTime() - startedAt);

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(this.#deps.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.body(slot),
        signal: AbortSignal.timeout(this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      body = await response.text();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "FAILED", failure: classifyFailure({ message: reason }), reason };
    }

    if (!response.ok) {
      return {
        kind: "FAILED",
        failure: classifyFailure({ httpStatus: response.status, message: body.slice(0, 200) }),
        reason: `HTTP ${String(response.status)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: "SCHEMA_REJECTED", reason: "Kein gueltiges JSON.", shape: "" };
    }

    // Wie ueberall beim JSON-RPC: der Fehlerast kommt mit HTTP 200.
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = (parsed as { error: { code?: unknown; message?: unknown } }).error;
      return {
        kind: "RPC_ERROR",
        code: typeof error.code === "number" ? error.code : 0,
        message: typeof error.message === "string" ? error.message : "unbekannt",
      };
    }

    const validated: ContractResult<Date | null> = this.#contract.validate(parsed);
    if (validated.kind !== "VALID") {
      return { kind: "SCHEMA_REJECTED", reason: validated.reason, shape: describeShape(parsed) };
    }
    return { kind: "OK", at: validated.value, latencyMs: elapsed() };
  }
}
