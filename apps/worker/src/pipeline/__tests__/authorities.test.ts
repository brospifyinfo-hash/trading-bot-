import { describe, expect, it } from "vitest";
import { isPresent, mint as toMint, type Clock } from "@sae/core";
import { SolanaMintAdapter, toMintAccountData } from "@sae/providers";

import { buildAuthorityReader } from "../authorities";

/**
 * Die Autoritaetspruefung des Vorsiebs.
 *
 * Der Vertrag ist bewusst noch ungeprueft — aus der Entwicklungsumgebung war
 * kein Solana-RPC erreichbar. Diese Tests pruefen deshalb genau das, was ohne
 * echte Antwort pruefbar IST: dass die Anfrage richtig gebaut wird, dass jeder
 * Ausfall als Nichtwissen mit passendem Grund ankommt, und dass die
 * Umwandlung die gefaehrlichen Faelle abfaengt.
 *
 * Was hier NICHT getestet wird, ist ob Solana so antwortet wie angenommen.
 * Das kann kein Test beantworten, sondern nur eine echte Antwort.
 */

const T0 = new Date("2026-09-06T22:00:00Z");
const clock: Clock = { now: () => T0 };
const MEME = toMint("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const RPC = "https://rpc.example.invalid";

function antwortet(body: string, status = 200): typeof fetch {
  return (async () =>
    ({ ok: status >= 200 && status < 300, status, text: async () => body }) as unknown as Response) as typeof fetch;
}

describe("Anfrage an den Mint-Account", () => {
  it("fragt jsonParsed und nicht base64", () => {
    // base64 hiesse: das Mint-Layout selbst aus Bytes lesen. Ein Versatzfehler
    // dabei ergaebe eine falsche Autoritaet — also eine falsche
    // Sicherheitsaussage, und das ist die teuerste Sorte Fehler hier.
    const body = JSON.parse(new SolanaMintAdapter({ clock, rpcUrl: RPC }).body(MEME)) as {
      method: string;
      params: [string, { encoding: string; commitment: string }];
    };
    expect(body.method).toBe("getAccountInfo");
    expect(body.params[0]).toBe(MEME);
    expect(body.params[1].encoding).toBe("jsonParsed");
    expect(body.params[1].commitment).toBe("confirmed");
  });
});

describe("Ausfaelle kommen als Nichtwissen an", () => {
  async function mit(fetchImpl: typeof fetch) {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await buildAuthorityReader({ clock, rpcUrl: RPC })(MEME);
    } finally {
      globalThis.fetch = original;
    }
  }

  it("meldet einen JSON-RPC-Fehler, obwohl er mit HTTP 200 kommt", async () => {
    // Der Fallstrick: wer nur `response.ok` prueft, haelt das hier fuer einen
    // Erfolg und liest dann `result` von `undefined`.
    const result = await mit(
      antwortet(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } })),
    );
    expect(isPresent(result.mintAuthorityActive)).toBe(false);
    if (isPresent(result.mintAuthorityActive)) return;
    expect(result.mintAuthorityActive.reason).toBe("PROVIDER_DOWN");
  });

  it("meldet eine Drosselung als solche", async () => {
    const result = await mit(antwortet("rate limited", 429));
    if (isPresent(result.freezeAuthorityActive)) throw new Error("erwartet: unbekannt");
    expect(result.freezeAuthorityActive.reason).toBe("PROVIDER_RATE_LIMITED");
  });

  it("meldet ohne konfiguriertes RPC, dass nichts erhoben wurde", async () => {
    const ohne = await buildAuthorityReader({ clock, rpcUrl: undefined })(MEME);
    if (isPresent(ohne.mintAuthorityActive)) throw new Error("erwartet: unbekannt");
    // NOT_YET_COLLECTED und nicht NOT_SUPPORTED_BY_PROVIDER: die Angabe ist
    // abrufbar, sie wurde nur nicht abgerufen.
    expect(ohne.mintAuthorityActive.reason).toBe("NOT_YET_COLLECTED");
  });

  it("liest eine gueltige Antwort jetzt aus, weil der Vertrag belegt ist", async () => {
    // Bis zur Messung vom 2026-09-10 lehnte der Vertrag jede Antwort mit
    // SCHEMA_UNVERIFIED ab. Jetzt traegt er.
    const gueltig = JSON.stringify({
      jsonrpc: "2.0",
      result: {
        context: { slot: 300_000_000 },
        value: {
          data: { program: "spl-token", parsed: { type: "mint", info: mintInfo() } },
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          executable: false,
        },
      },
    });
    const result = await mit(antwortet(gueltig));
    if (!isPresent(result.mintAuthorityActive)) {
      throw new Error("erwartet: jetzt bekannt");
    }
    // mintAuthority: null im Fixture heisst "niemand kann nachpraegen".
    expect(result.mintAuthorityActive.value).toBe(false);
  });
});

function mintInfo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decimals: 6,
    supply: "1000000000000000",
    isInitialized: true,
    mintAuthority: null,
    freezeAuthority: null,
    ...over,
  };
}

describe("Umwandlung der Antwort", () => {
  function antwort(over: Record<string, unknown> = {}, info: Record<string, unknown> = {}): unknown {
    return {
      jsonrpc: "2.0",
      result: {
        context: { slot: 300_000_000 },
        value: {
          data: { program: "spl-token", parsed: { type: "mint", info: mintInfo(info) } },
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          executable: false,
          ...over,
        },
      },
    };
  }

  it("liest abgegebene Autoritaeten als inaktiv", () => {
    const account = toMintAccountData(antwort());
    expect(account?.mintAuthorityActive).toBe(false);
    expect(account?.freezeAuthorityActive).toBe(false);
    expect(account?.decimals).toBe(6);
    // Der Slot ist unser eigener Zeitanker fuer diesen Wert — anders als bei
    // Marktdaten von DexScreener ist das Alter hier bekannt.
    expect(account?.slot).toBe(300_000_000);
  });

  it("liest eine gesetzte Mint-Authority als aktiv", () => {
    const account = toMintAccountData(antwort({}, { mintAuthority: MEME }));
    expect(account?.mintAuthorityActive).toBe(true);
  });

  it("haelt den Supply als Text", () => {
    // u64 passt nicht verlustfrei in eine JSON-Zahl. Ihn zu parsen hiesse,
    // bei grossen Supplies still falsche Werte zu fuehren.
    expect(toMintAccountData(antwort())?.supplyRaw).toBe("1000000000000000");
  });

  it("verwirft einen Token-Account, der wie ein Mint aussieht", () => {
    // Gleiche aeussere Form, andere Bedeutung. Ihn als Mint zu lesen ergaebe
    // Autoritaeten, die es nicht gibt.
    const alsToken = {
      jsonrpc: "2.0",
      result: {
        context: { slot: 1 },
        value: {
          data: { program: "spl-token", parsed: { type: "account", info: mintInfo() } },
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          executable: false,
        },
      },
    };
    expect(toMintAccountData(alsToken)).toBeNull();
  });

  it("verwirft einen Account, der einem fremden Programm gehoert", () => {
    expect(toMintAccountData(antwort({ owner: "11111111111111111111111111111111" }))).toBeNull();
  });

  it("nimmt Token-2022 an", () => {
    const account = toMintAccountData(
      antwort({ owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }),
    );
    expect(account?.tokenProgram).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });

  it("meldet eine leere Adresse als kein Account", () => {
    const leer = { jsonrpc: "2.0", result: { context: { slot: 1 }, value: null } };
    expect(toMintAccountData(leer)).toBeNull();
  });
});
