import type { Clock } from "@sae/core";
import { describeShape } from "@sae/observability";
import { z } from "zod";

import { classifyFailure, type FailureClass } from "../capability";
import { unverifiedContract, type ContractResult, type ResponseContract } from "../contract";

/**
 * `getTokenLargestAccounts` — die Verteilung, direkt von der Kette.
 *
 * Der Grund, warum diese Datei entsteht: von neun Teilscores fehlt genau einer
 * an einem einzigen Pflichtfeld — `top10HolderSharePct`, Gewicht 0.20
 * (DECISIONS §111). Bisher war die Annahme, dafuer brauche es einen externen
 * Sicherheitsanbieter. Die Kette selbst kennt die groessten Token-Konten
 * eines Mint, und zusammen mit der Gesamtmenge — die wir aus dem Mint-Konto
 * ohnehin schon lesen — ergibt das den Anteil.
 *
 * ### Was diese Zahl IST und was sie NICHT ist
 *
 * Sie misst die Konzentration ueber **Token-Konten**, nicht ueber Besitzer.
 * Das ist ein echter Unterschied und er wird hier nicht weggeredet:
 *
 * - Ein Besitzer kann mehrere Konten halten. Die Konzentration ist dann
 *   HOEHER als gemessen.
 * - Unter den groessten Konten stehen regelmaessig Liquiditaetspools und
 *   Boersen-Wallets. Die gehoeren niemandem im gemeinten Sinn, und die
 *   Konzentration ist dann NIEDRIGER als gemessen.
 *
 * Beide Abweichungen zeigen in verschiedene Richtungen und heben sich NICHT
 * auf. Wer die Zahl als „Anteil der zehn groessten Halter" liest, liest sie
 * falsch. Genau deshalb heisst der Feature-Wert weiterhin, was er misst, und
 * der Sicherheits-Teilscore behandelt ihn als das, was er ist: ein
 * Konzentrationsmass mit bekannter Unschaerfe — besser als kein Mass, und
 * ausdruecklich keine Aussage ueber Personen.
 *
 * Ein Anbieter wie RugCheck oder Helius kann die Konten Besitzern zuordnen
 * und Pools erkennen. Das bleibt der bessere Wert; dieser hier ist der, den es
 * ohne einen weiteren Anbieter gibt.
 *
 * ### Ungeprueft
 *
 * Der Vertrag ist `unverified`. Aus dieser Umgebung ist kein Solana-RPC
 * erreichbar; die Sonde im provider-health-Takt misst die Form im Betrieb —
 * derselbe Weg, auf dem `getAccountInfo`, `getBlockTime` und der Jupiter-Quote
 * belegt wurden.
 */

export const GET_TOKEN_LARGEST_ACCOUNTS = "getTokenLargestAccounts";

/** Ein Token-Konto, wie das RPC es in `value` legt. */
const accountSchema = z
  .object({
    address: z.string(),
    /** Rohmenge als Text — u64 passt nicht verlustfrei in eine JSON-Zahl. */
    amount: z.string().regex(/^\d+$/),
    decimals: z.number().int().min(0).max(255),
  })
  .passthrough();

export const largestAccountsResultSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    result: z
      .object({
        context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
        value: z.array(accountSchema),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Konzentration ueber KONTEN — bewusst nicht „Holder" im Namen.
 *
 * Der Unterschied zu `HolderConcentration` aus dem RugCheck-Modul ist keine
 * Wortklauberei: dort werden Konten nach Besitzern zusammengefasst und Pools
 * ausgeschlossen, hier ist beides unmoeglich, weil die Kette weder `owner`
 * noch eine Liste bekannter Pools mitliefert. Beim gemessenen Memecoin ist das
 * der Unterschied zwischen 95,7 % und 55,7 % (DECISIONS §113).
 *
 * Der Name sagt deshalb, was gemessen wurde. Wer diese Zahl als
 * Halterkonzentration fuehrt, fuehrt sie falsch.
 */
export interface AccountConcentration {
  /** Anteil der zehn groessten KONTEN an der Gesamtmenge, in Prozent. */
  readonly top10SharePct: number;
  /** Anteil des groessten einzelnen KONTOS, in Prozent. */
  readonly topSharePct: number;
  /** Wie viele Konten die Antwort ueberhaupt enthielt. */
  readonly accountsReported: number;
}

export const SOLANA_LARGEST_ACCOUNTS_CONTRACT: ResponseContract<readonly bigint[]> =
  unverifiedContract({
    provider: "solana-rpc",
    endpoint: GET_TOKEN_LARGEST_ACCOUNTS,
    needed:
      "Eine echte Antwort von getTokenLargestAccounts. Dann wird aus " +
      "unverifiedContract() ein zodContract({verified: true}) mit toAmounts.",
  });

/** Die Rohmengen der gemeldeten Konten, absteigend — oder `null` bei Abweichung. */
export function toAmounts(raw: unknown): readonly bigint[] | null {
  const parsed = largestAccountsResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.result.value
    .map((account) => BigInt(account.amount))
    .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
}

/**
 * Konzentration aus Mengen und Gesamtmenge.
 *
 * Getrennt vom Abruf, weil hier die gefaehrlichen Fehler wohnen: eine
 * vertauschte Gesamtmenge verschiebt jeden Anteil, und das Ergebnis saehe
 * trotzdem wie ein Prozentwert aus.
 *
 * `null` statt einer Zahl, wenn die Gesamtmenge 0 ist oder die Summe der
 * Konten sie uebersteigt. Das Zweite kann nur heissen, dass Mengen und
 * Gesamtmenge nicht zusammengehoeren — und dann ist ein Prozentwert daraus
 * schlimmer als keiner.
 */
export function concentrationOf(input: {
  readonly amounts: readonly bigint[];
  readonly totalSupplyRaw: bigint;
}): AccountConcentration | null {
  const { amounts, totalSupplyRaw } = input;
  if (totalSupplyRaw <= 0n || amounts.length === 0) return null;

  const sorted = [...amounts].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
  const top10 = sorted.slice(0, 10).reduce((sum, a) => sum + a, 0n);
  const largest = sorted[0] ?? 0n;
  if (top10 > totalSupplyRaw) return null;

  // Ganzzahlig bis zur letzten Division: erst Basispunkte, dann Prozent.
  const pct = (part: bigint): number => Number((part * 1_000_000n) / totalSupplyRaw) / 10_000;

  return {
    top10SharePct: pct(top10),
    topSharePct: pct(largest),
    accountsReported: sorted.length,
  };
}

export type LargestAccountsOutcome =
  | { readonly kind: "OK"; readonly amounts: readonly bigint[]; readonly latencyMs: number }
  | { readonly kind: "SCHEMA_REJECTED"; readonly reason: string; readonly shape: string }
  | { readonly kind: "RPC_ERROR"; readonly code: number; readonly message: string }
  | { readonly kind: "FAILED"; readonly failure: FailureClass; readonly reason: string };

export interface LargestAccountsDeps {
  readonly clock: Clock;
  readonly rpcUrl: string;
  readonly contract?: ResponseContract<readonly bigint[]>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class SolanaLargestAccountsAdapter {
  readonly #deps: LargestAccountsDeps;
  readonly #contract: ResponseContract<readonly bigint[]>;

  constructor(deps: LargestAccountsDeps) {
    this.#deps = deps;
    this.#contract = deps.contract ?? SOLANA_LARGEST_ACCOUNTS_CONTRACT;
  }

  get contractVerified(): boolean {
    return this.#contract.verified;
  }

  body(mint: string): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: GET_TOKEN_LARGEST_ACCOUNTS,
      params: [mint, { commitment: "confirmed" }],
    });
  }

  async fetchLargestAccounts(mint: string): Promise<LargestAccountsOutcome> {
    const startedAt = this.#deps.clock.now().getTime();
    const elapsed = (): number => Math.max(0, this.#deps.clock.now().getTime() - startedAt);

    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(this.#deps.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.body(mint),
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

    const validated: ContractResult<readonly bigint[]> = this.#contract.validate(parsed);
    if (validated.kind !== "VALID") {
      return { kind: "SCHEMA_REJECTED", reason: validated.reason, shape: describeShape(parsed) };
    }
    return { kind: "OK", amounts: validated.value, latencyMs: elapsed() };
  }
}
