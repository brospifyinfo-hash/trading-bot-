import { describeShape } from "@sae/observability";
import { z } from "zod";

import { classifyFailure, type FailureClass } from "../capability";
import { unverifiedContract, type ContractResult, type ResponseContract } from "../contract";

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
 *
 * Der Vertrag ist ungeprueft: aus der Entwicklungsumgebung ist kein Solana-RPC
 * erreichbar. Die Sonde im provider-health-Takt misst die Form im Betrieb.
 */

export const GET_BLOCK_TIME = "getBlockTime";

export const blockTimeResultSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    /** Unix-Sekunden, oder null wenn der Slot nicht verfuegbar ist. */
    result: z.number().int().nullable(),
  })
  .passthrough();

export const SOLANA_BLOCK_TIME_CONTRACT: ResponseContract<Date | null> = unverifiedContract({
  provider: "solana-rpc",
  endpoint: GET_BLOCK_TIME,
  needed:
    "Eine echte Antwort von getBlockTime. Dann wird aus unverifiedContract() " +
    "ein zodContract({verified: true}) mit toBlockTime als Transformation.",
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
  const seconds = parsed.data.result;
  if (seconds === null) return null;
  return new Date(seconds * 1_000);
}

export interface BlockTimeDeps {
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
    return { kind: "OK", at: validated.value, latencyMs: 0 };
  }
}
