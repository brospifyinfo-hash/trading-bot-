import { readFileSync } from "node:fs";

/**
 * Schluesselverwaltung.
 *
 * Der Schluessel wird aus einem Docker-Secret gelesen und bleibt im Speicher.
 * Die Klasse hat bewusst keinen Getter, keine toJSON, keine toString und keinen
 * inspect-Hook, der ihn herausgeben wuerde — jeder Versuch, das Objekt zu
 * serialisieren oder zu loggen, ergibt eine Platzhalterzeichenkette.
 *
 * Signiert wird ueber `withKey`, das den Schluessel nur an eine Funktion reicht
 * und ihn nicht zurueckgibt.
 */
export class Keystore {
  readonly #secret: Uint8Array;
  readonly publicKey: string;

  private constructor(secret: Uint8Array, publicKey: string) {
    this.#secret = secret;
    this.publicKey = publicKey;
  }

  static loadFromFile(path: string, derivePublicKey: (secret: Uint8Array) => string): Keystore {
    const raw = readFileSync(path, "utf8").trim();
    const secret = parseSecret(raw);
    if (secret.length !== 64) {
      throw new Error(`Schluesseldatei ${path} enthaelt ${secret.length} Byte, erwartet 64`);
    }
    return new Keystore(secret, derivePublicKey(secret));
  }

  /** Nur fuer Tests: erzeugt einen Keystore aus vorhandenen Bytes. */
  static fromBytes(secret: Uint8Array, publicKey: string): Keystore {
    return new Keystore(secret, publicKey);
  }

  withKey<T>(fn: (secret: Uint8Array) => T): T {
    return fn(this.#secret);
  }

  toJSON(): string {
    return "[Keystore]";
  }

  toString(): string {
    return "[Keystore]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[Keystore]";
  }
}

function parseSecret(raw: string): Uint8Array {
  if (raw.startsWith("[")) {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Schluesseldatei ist kein Byte-Array");
    return Uint8Array.from(parsed as number[]);
  }
  // Base58 wird in Phase 12 mit der dann festgelegten Solana-Bibliothek ergaenzt.
  throw new Error("Nicht unterstuetztes Schluesselformat — erwartet wird ein 64-Byte-Array");
}
