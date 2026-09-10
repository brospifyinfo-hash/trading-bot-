import { FixedClock } from "@sae/core";
import { describe, expect, it } from "vitest";

import {
  SOLANA_BLOCK_TIME_CONTRACT,
  SolanaBlockTimeAdapter,
  toBlockTime,
} from "../block-time";

/**
 * Vertragstests gegen `getBlockTime`.
 *
 * Anders als bei den Jupiter-Fixtures ist die Form hier **gemessen**, nicht
 * aus einer Spezifikation abgeleitet: die Sonde im provider-health-Takt hat am
 * 2026-09-10 gegen den konfigurierten Endpunkt
 * `id:number · jsonrpc:string · result:number` gemeldet. Das Fixture unten ist
 * genau diese Form.
 */

/** Die gemessene Antwortform. `result` sind Unix-SEKUNDEN. */
const MEASURED = { id: 1, jsonrpc: "2.0", result: 1_757_468_000 };

describe("SOLANA_BLOCK_TIME_CONTRACT", () => {
  it("ist geprueft und traegt eine Version, keine UNVERIFIED-Marke", () => {
    expect(SOLANA_BLOCK_TIME_CONTRACT.verified).toBe(true);
    expect(SOLANA_BLOCK_TIME_CONTRACT.schemaVersion).toBe("solana-getblocktime-v1@2026-09-10");
  });

  it("liest die gemessene Antwort als Sekunden, nicht als Millisekunden", () => {
    const result = SOLANA_BLOCK_TIME_CONTRACT.validate(MEASURED);
    expect(result.kind).toBe("VALID");
    if (result.kind !== "VALID") return;
    expect(result.value).toEqual(new Date(1_757_468_000_000));
  });

  /**
   * Der Faktor-1000-Fehler faellt hier auf und nirgends sonst.
   *
   * Millisekunden gelesen ergaebe 1970, Sekunden mal 1000 zu viel ergaebe das
   * Jahr 57 000. Beide Faelle wuerden flussabwaerts ein Datenalter erzeugen,
   * das um Faktor 1000 danebenliegt — und ein zu junges Alter oeffnet den
   * Torwaechter fuer Daten, die laengst veraltet sind.
   */
  it("landet in diesem Jahrzehnt", () => {
    const result = SOLANA_BLOCK_TIME_CONTRACT.validate(MEASURED);
    if (result.kind !== "VALID" || result.value === null) throw new Error("kein Datum");
    expect(result.value.getUTCFullYear()).toBeGreaterThanOrEqual(2020);
    expect(result.value.getUTCFullYear()).toBeLessThanOrEqual(2100);
  });

  /** `null` ist eine Auskunft: der Slot ist nicht (mehr) verfuegbar. */
  it("nimmt result: null als gueltige Antwort an", () => {
    const result = SOLANA_BLOCK_TIME_CONTRACT.validate({ id: 1, jsonrpc: "2.0", result: null });
    expect(result.kind).toBe("VALID");
    if (result.kind !== "VALID") return;
    expect(result.value).toBeNull();
  });

  /**
   * Der Unterschied, an dem der ganze Vertragsbegriff haengt: eine ABWEICHENDE
   * Antwort wird abgelehnt und nicht stillschweigend zu `null`. Sonst saehe
   * ein Formatwechsel des Anbieters aus wie ein nicht verfuegbarer Slot.
   */
  it("lehnt eine abweichende Antwort ab, statt sie zu null zu machen", () => {
    expect(SOLANA_BLOCK_TIME_CONTRACT.validate({ jsonrpc: "2.0", result: "1757468000" }).kind).toBe(
      "INVALID",
    );
    expect(SOLANA_BLOCK_TIME_CONTRACT.validate({ jsonrpc: "1.0", result: 1 }).kind).toBe("INVALID");
    expect(SOLANA_BLOCK_TIME_CONTRACT.validate({ result: 1 }).kind).toBe("INVALID");
  });

  /** Unbekannte Zusatzfelder brechen nichts — `id` ist genau so eines. */
  it("laesst zusaetzliche Felder stehen", () => {
    expect(
      SOLANA_BLOCK_TIME_CONTRACT.validate({ ...MEASURED, spaeteresFeld: "egal" }).kind,
    ).toBe("VALID");
  });
});

describe("toBlockTime", () => {
  it("gibt bei Unsinn null zurueck", () => {
    expect(toBlockTime(null)).toBeNull();
    expect(toBlockTime("nein")).toBeNull();
    expect(toBlockTime({ jsonrpc: "2.0" })).toBeNull();
  });

  it("stimmt mit dem Vertrag ueberein", () => {
    const viaContract = SOLANA_BLOCK_TIME_CONTRACT.validate(MEASURED);
    if (viaContract.kind !== "VALID") throw new Error("Vertrag lehnt das Fixture ab");
    expect(toBlockTime(MEASURED)).toEqual(viaContract.value);
  });
});

describe("SolanaBlockTimeAdapter", () => {
  const RPC = "https://rpc.example/solana";

  function adapterWith(clock: FixedClock, fetchImpl: typeof fetch): SolanaBlockTimeAdapter {
    return new SolanaBlockTimeAdapter({ clock, rpcUrl: RPC, fetchImpl });
  }

  it("baut die Anfrage mit dem Slot als einzigem Parameter", () => {
    const clock = new FixedClock(new Date("2026-09-10T00:00:00Z"));
    const body = JSON.parse(
      adapterWith(clock, (() => {
        throw new Error("nicht aufrufen");
      }) as unknown as typeof fetch).body(301_234_567),
    ) as { method: string; params: unknown[] };
    expect(body.method).toBe("getBlockTime");
    expect(body.params).toEqual([301_234_567]);
  });

  it("liefert die Uhrzeit und eine GEMESSENE Latenz", async () => {
    const clock = new FixedClock(new Date("2026-09-10T00:00:00Z"));
    const adapter = adapterWith(clock, (async () => {
      // Der Abruf kostet Zeit — die Uhr wird waehrenddessen weitergestellt.
      clock.advance(137);
      return new Response(JSON.stringify(MEASURED), { status: 200 });
    }) as unknown as typeof fetch);

    const outcome = await adapter.fetchBlockTime(301_234_567);
    expect(outcome.kind).toBe("OK");
    if (outcome.kind !== "OK") return;
    expect(outcome.at).toEqual(new Date(1_757_468_000_000));
    // Der Kern dieser Zeile: vorher stand hier fest `0`, eine erfundene Zahl.
    expect(outcome.latencyMs).toBe(137);
  });

  it("meldet einen JSON-RPC-Fehler als solchen, obwohl er mit HTTP 200 kommt", async () => {
    const clock = new FixedClock(new Date("2026-09-10T00:00:00Z"));
    const adapter = adapterWith(clock, (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32004, message: "Block not available" } }), {
        status: 200,
      })) as unknown as typeof fetch);

    const outcome = await adapter.fetchBlockTime(1);
    expect(outcome.kind).toBe("RPC_ERROR");
    if (outcome.kind !== "RPC_ERROR") return;
    expect(outcome.code).toBe(-32004);
  });

  it("fragt gar nicht erst nach einem ungueltigen Slot", async () => {
    const clock = new FixedClock(new Date("2026-09-10T00:00:00Z"));
    let calls = 0;
    const adapter = adapterWith(clock, (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    expect((await adapter.fetchBlockTime(-1)).kind).toBe("SCHEMA_REJECTED");
    expect((await adapter.fetchBlockTime(1.5)).kind).toBe("SCHEMA_REJECTED");
    expect(calls).toBe(0);
  });

  it("haelt eine abweichende Antwort fest, statt sie zu verschlucken", async () => {
    const clock = new FixedClock(new Date("2026-09-10T00:00:00Z"));
    const adapter = adapterWith(clock, (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", result: "spaet" }), {
        status: 200,
      })) as unknown as typeof fetch);

    const outcome = await adapter.fetchBlockTime(301_234_567);
    expect(outcome.kind).toBe("SCHEMA_REJECTED");
    if (outcome.kind !== "SCHEMA_REJECTED") return;
    // Die Form wandert ins Log — ohne sie waere der naechste Formatwechsel
    // wieder eine Suche statt einer Ablesung.
    expect(outcome.shape).toContain("result:string");
  });
});
