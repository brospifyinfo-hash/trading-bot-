import { missing, observed, type Clock, type Mint } from "@sae/core";
import type { TokenAuthorities } from "@sae/discovery";
import { SolanaMintAdapter, SOLANA_RPC_PROVIDER_ID } from "@sae/providers";

/**
 * Die Autoritaetspruefung des Vorsiebs.
 *
 * Sie schliesst die Naht, die `DiscoveryRunDeps.checkAuthorities` seit §87
 * offen laesst. Was sie NICHT tut: einen Wert behaupten, den sie nicht hat.
 * Jeder Ausfall wird zu `Missing` mit dem Grund, der ihn erklaert — und
 * `cheapScreen` lehnt bei Unbekanntem nicht ab, weshalb der Lauf jede Luecke
 * weiter zaehlt und meldet.
 *
 * ### Solange der Vertrag ungeprueft ist
 *
 * Der Adapter traegt `unverifiedContract()`, weil aus der Entwicklungsumgebung
 * kein Solana-RPC erreichbar war. Er fuehrt die Anfrage vollstaendig aus und
 * lehnt die Antwort dann mit `SCHEMA_UNVERIFIED` ab. Fuer den Betrieb heisst
 * das: es aendert sich noch nichts, ausser dass die Anfrage messbar
 * stattfindet. Genau das ist erwuenscht — der Weg zum scharfen Modul ist ein
 * Zeilentausch im Vertrag und kein neues Modul.
 */

export interface AuthorityReaderDeps {
  readonly clock: Clock;
  /** Fehlt sie, gibt es keine Pruefung — und das wird gemeldet, nicht geraten. */
  readonly rpcUrl: string | undefined;
  readonly timeoutMs?: number;
}

export type AuthorityReader = (mint: Mint) => Promise<TokenAuthorities>;

/**
 * Baut den Leser — oder einen, der ehrlich nichts weiss.
 *
 * Ohne `SOLANA_RPC_URL` waere die Alternative, den Aufrufer mit `undefined`
 * umgehen zu lassen. Dann stuenden zwei Wege fuer denselben Fall im Code, und
 * einer davon wuerde irgendwann vergessen.
 */
export function buildAuthorityReader(deps: AuthorityReaderDeps): AuthorityReader {
  const url = deps.rpcUrl;
  if (url === undefined || url.trim() === "") {
    return async (): Promise<TokenAuthorities> => unknownAuthorities("NOT_YET_COLLECTED", deps.clock);
  }

  const adapter = new SolanaMintAdapter({
    clock: deps.clock,
    rpcUrl: url,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });

  return async (mint: Mint): Promise<TokenAuthorities> => {
    const outcome = await adapter.fetchMint(mint);

    if (outcome.kind === "OK") {
      if (outcome.account === null) {
        // Die Adresse traegt keinen Mint-Account. Das ist eine Auskunft ueber
        // den Token und keine ueber den Anbieter.
        return unknownAuthorities("NO_DATA_FOR_TOKEN", deps.clock);
      }
      const at = deps.clock.now();
      return {
        mintAuthorityActive: observed(outcome.account.mintAuthorityActive, SOLANA_RPC_PROVIDER_ID, at),
        freezeAuthorityActive: observed(
          outcome.account.freezeAuthorityActive,
          SOLANA_RPC_PROVIDER_ID,
          at,
        ),
      };
    }

    // Alle uebrigen Aeste sind Nichtwissen, nur mit verschiedenen Ursachen.
    // Sie auseinanderzuhalten entscheidet spaeter, ob jemand einen Vertrag
    // belegt, ein Zeitlimit erhoeht oder den Anbieter wechselt.
    switch (outcome.kind) {
      case "SCHEMA_REJECTED":
        return unknownAuthorities("PARSE_FAILED", deps.clock);
      case "RPC_ERROR":
        return unknownAuthorities("PROVIDER_DOWN", deps.clock);
      case "FAILED":
        return unknownAuthorities(
          outcome.timedOut
            ? "PROVIDER_TIMEOUT"
            : outcome.failure === "RATE_LIMITED"
              ? "PROVIDER_RATE_LIMITED"
              : "PROVIDER_DOWN",
          deps.clock,
        );
    }
  };
}

function unknownAuthorities(
  reason: Parameters<typeof missing>[0],
  clock: Clock,
): TokenAuthorities {
  const at = clock.now();
  return {
    mintAuthorityActive: missing(reason, at, SOLANA_RPC_PROVIDER_ID),
    freezeAuthorityActive: missing(reason, at, SOLANA_RPC_PROVIDER_ID),
  };
}
