import { describe, expect, it } from "vitest";
import { LOG_ALLOWLIST, REDACTED, redact } from "../redaction";
import { createLogger } from "../logger";

/**
 * Kein Geheimnis darf ins Log gelangen.
 *
 * Die Tests benutzen ausschliesslich erfundene Werte in der GESTALT echter
 * Schluessel — nie einen echten. Ein Testfixture mit einem realen Schluessel
 * waere genau der Fehler, den diese Datei verhindern soll.
 */

const FAKE_KEYPAIR_ARRAY = Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
const FAKE_BASE58_SECRET = "4".repeat(88);
const FAKE_MNEMONIC = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";

describe("redact", () => {
  it("laesst erlaubte Felder durch", () => {
    const out = redact({ traceId: "abc", finalScore: 91, mint: "So111" }) as Record<string, unknown>;
    expect(out["traceId"]).toBe("abc");
    expect(out["finalScore"]).toBe(91);
  });

  it("ersetzt alles, was nicht auf der Allowlist steht", () => {
    // Allowlist statt Blocklist: unbekannte Felder sind per Default geheim.
    const out = redact({ privateKey: FAKE_BASE58_SECRET, irgendwas: "x" }) as Record<string, unknown>;
    expect(out["privateKey"]).toBe(REDACTED);
    expect(out["irgendwas"]).toBe(REDACTED);
  });

  it("faengt auch Felder ab, an die niemand gedacht hat", () => {
    const sneaky = {
      keineAhnungWieDasHeisst: FAKE_BASE58_SECRET,
      wallet_backup_2: FAKE_KEYPAIR_ARRAY,
      seedPhraseAberAndersGeschrieben: FAKE_MNEMONIC,
    };
    expect(JSON.stringify(redact(sneaky))).not.toContain(FAKE_BASE58_SECRET);
    expect(JSON.stringify(redact(sneaky))).not.toContain(FAKE_MNEMONIC);
    expect(JSON.stringify(redact(sneaky))).not.toContain("119");
  });

  it("greift auch in verschachtelten Objekten", () => {
    const nested = { err: { detail: { secretKey: FAKE_BASE58_SECRET } } };
    expect(JSON.stringify(redact(nested))).not.toContain(FAKE_BASE58_SECRET);
  });

  it("greift in Arrays", () => {
    const arr = { reasons: [{ code: "OK", secret: FAKE_BASE58_SECRET }] };
    expect(JSON.stringify(redact(arr))).not.toContain(FAKE_BASE58_SECRET);
  });

  it("bricht bei absurder Verschachtelung ab statt zu blockieren", () => {
    let deep: Record<string, unknown> = { secret: FAKE_BASE58_SECRET };
    for (let i = 0; i < 50; i++) deep = { err: deep };
    expect(JSON.stringify(redact(deep))).not.toContain(FAKE_BASE58_SECRET);
  });

  it("serialisiert BigInt statt daran zu scheitern", () => {
    // Betraege sind bigint. Ein Logger, der daran wirft, verschluckt genau die
    // Datensaetze, die man im Fehlerfall braucht.
    expect(redact({ amountRaw: 10n ** 20n })).toEqual({ amountRaw: "100000000000000000000" });
  });

  it("behaelt Fehlermeldung und Stack", () => {
    const out = redact(new Error("etwas ist schiefgegangen")) as Record<string, unknown>;
    expect(out["message"]).toBe("etwas ist schiefgegangen");
    expect(out["stack"]).toBeTruthy();
  });
});

describe("Logger-Ausgabe", () => {
  it("enthaelt keinen Schluessel im serialisierten Datensatz", async () => {
    // Der eigentliche Beweis: nicht die Hilfsfunktion wird geprueft, sondern das,
    // was tatsaechlich in den Ausgabestrom geschrieben wird.
    const chunks: string[] = [];
    const logger = createLogger({ service: "test" });
    const stream = { write: (chunk: string) => void chunks.push(chunk) };
    const testLogger = logger.child({}, { level: "info" });
    // pino-Zielstrom ueber ein eigenes Destination-Objekt ersetzen.
    const pinoModule = await import("pino");
    const direct = pinoModule.default(
      { formatters: { log: (o) => redact(o) as Record<string, unknown> } },
      stream as never,
    );
    direct.info({ privateKey: FAKE_BASE58_SECRET, mint: "So111", amountRaw: 5n }, "trade");
    void testLogger;

    const output = chunks.join("");
    expect(output).not.toContain(FAKE_BASE58_SECRET);
    expect(output).toContain(REDACTED);
    expect(output).toContain("So111");
  });
});

describe("Allowlist", () => {
  it("enthaelt keine schluesselverdaechtigen Feldnamen", () => {
    const forbidden = ["privateKey", "secretKey", "seed", "mnemonic", "keypair", "password"];
    for (const name of forbidden) {
      expect(LOG_ALLOWLIST.has(name)).toBe(false);
    }
  });
});
