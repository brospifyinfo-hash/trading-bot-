import { beforeEach, describe, expect, it } from "vitest";
import { PolicyViolation } from "@sae/core";
import {
  SignerPolicy,
  type DecodedTransaction,
  type IntentFacts,
  type PolicyConfig,
} from "../policy";
import { Keystore } from "../keystore";

/**
 * Die Policy muss halten, wenn der Aufrufer nicht mehr vertrauenswuerdig ist.
 *
 * Jeder Test hier simuliert einen kompromittierten Execution-Worker, der eine
 * manipulierte Transaktion zum Signieren schickt.
 */

const TRADING = "TradingWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ATTACKER = "AttackerWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const EVIL_PROGRAM = "EvilProgram1111111111111111111111111111111";
const TIP_ACCOUNT = "TipAccount11111111111111111111111111111111";
const EXPECTED_MINT = "So11111111111111111111111111111111111111112";
const OTHER_MINT = "0ther1111111111111111111111111111111111111";

const config: PolicyConfig = {
  allowedProgramIds: new Set([JUPITER, TOKEN_PROGRAM]),
  tradingWallet: TRADING,
  allowedDirectRecipients: new Set([TIP_ACCOUNT]),
  maxSolOutPerTxLamports: 500_000_000n, // 0,5 SOL
  maxSolOutPerWindowLamports: 2_000_000_000n, // 2 SOL
  windowMs: 3_600_000,
};

const validIntent: IntentFacts = { expectedMint: EXPECTED_MINT, stillActive: true };

const validTx = (overrides: Partial<DecodedTransaction> = {}): DecodedTransaction => ({
  feePayer: TRADING,
  programIds: [JUPITER, TOKEN_PROGRAM],
  solTransfers: [{ from: TRADING, to: JUPITER, lamports: 100_000_000n }],
  tokenMints: [EXPECTED_MINT],
  minOutAmount: 950_000n,
  ...overrides,
});

let policy: SignerPolicy;
let counter = 0;
const nextIntent = () => `intent-${counter++}`;

beforeEach(() => {
  policy = new SignerPolicy(config);
});

const expectRejection = (
  tx: DecodedTransaction,
  check: string,
  intent: IntentFacts = validIntent,
) => {
  try {
    policy.check({ intentId: nextIntent(), transaction: tx }, intent, Date.now());
    expect.unreachable(`haette wegen ${check} abgelehnt werden muessen`);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyViolation);
    expect((error as PolicyViolation).policy).toBe(check);
  }
};

describe("Zulaessige Transaktion", () => {
  it("wird durchgelassen", () => {
    const outflow = policy.check(
      { intentId: nextIntent(), transaction: validTx() },
      validIntent,
      Date.now(),
    );
    expect(outflow).toBe(100_000_000n);
  });
});

describe("Manipulierte Transaktionen", () => {
  it("lehnt ein nicht zugelassenes Programm ab", () => {
    expectRejection(validTx({ programIds: [JUPITER, EVIL_PROGRAM] }), "PROGRAM_NOT_ALLOWED");
  });

  it("lehnt einen fremden Gebuehrenzahler ab", () => {
    expectRejection(validTx({ feePayer: ATTACKER }), "WRONG_FEE_PAYER");
  });

  it("lehnt einen getauschten SOL-Empfaenger ab", () => {
    // Der klassische Angriff: Route stimmt, aber das SOL geht woandershin.
    expectRejection(
      validTx({ solTransfers: [{ from: TRADING, to: ATTACKER, lamports: 100_000_000n }] }),
      "UNEXPECTED_SOL_RECIPIENT",
    );
  });

  it("lehnt einen Abfluss ueber dem Transaktionslimit ab", () => {
    expectRejection(
      validTx({ solTransfers: [{ from: TRADING, to: JUPITER, lamports: 600_000_000n }] }),
      "SOL_OUT_EXCEEDS_TX_LIMIT",
    );
  });

  it("lehnt einen anderen Mint als den freigegebenen ab", () => {
    expectRejection(validTx({ tokenMints: [OTHER_MINT] }), "MINT_MISMATCH");
  });

  it("lehnt eine fehlende Mindestausgabemenge ab", () => {
    expectRejection(validTx({ minOutAmount: null }), "MIN_OUT_MISSING");
  });

  it("lehnt minOut = 0 ab", () => {
    // minOut = 0 heisst: jeder Ausgang ist akzeptabel, auch ein Totalverlust.
    expectRejection(validTx({ minOutAmount: 0n }), "MIN_OUT_ZERO");
  });

  it("lehnt einen inaktiven Intent ab", () => {
    expectRejection(validTx(), "INTENT_NOT_ACTIVE", {
      expectedMint: EXPECTED_MINT,
      stillActive: false,
    });
  });
});

describe("Replay-Schutz", () => {
  it("signiert denselben Intent kein zweites Mal", () => {
    const intentId = "wiederholter-intent";
    policy.check({ intentId, transaction: validTx() }, validIntent, Date.now());
    try {
      policy.check({ intentId, transaction: validTx() }, validIntent, Date.now());
      expect.unreachable("Replay haette abgelehnt werden muessen");
    } catch (error) {
      expect((error as PolicyViolation).policy).toBe("INTENT_REPLAY");
    }
  });
});

describe("Zeitfensterlimit", () => {
  it("summiert Abfluesse ueber mehrere Transaktionen", () => {
    const now = Date.now();
    const tx = validTx({ solTransfers: [{ from: TRADING, to: JUPITER, lamports: 500_000_000n }] });
    for (let i = 0; i < 4; i++) {
      policy.check({ intentId: nextIntent(), transaction: tx }, validIntent, now + i);
    }
    // Fuenfte Transaktion sprengt das Fensterlimit von 2 SOL.
    try {
      policy.check({ intentId: nextIntent(), transaction: tx }, validIntent, now + 5);
      expect.unreachable("Fensterlimit haette greifen muessen");
    } catch (error) {
      expect((error as PolicyViolation).policy).toBe("SOL_OUT_EXCEEDS_WINDOW_LIMIT");
    }
  });

  it("gibt das Kontingent nach Ablauf des Fensters wieder frei", () => {
    const now = Date.now();
    const tx = validTx({ solTransfers: [{ from: TRADING, to: JUPITER, lamports: 500_000_000n }] });
    for (let i = 0; i < 4; i++) {
      policy.check({ intentId: nextIntent(), transaction: tx }, validIntent, now + i);
    }
    const later = now + config.windowMs + 1_000;
    expect(() =>
      policy.check({ intentId: nextIntent(), transaction: tx }, validIntent, later),
    ).not.toThrow();
  });

  it("zaehlt eingehende Transfers nicht als Abfluss", () => {
    const tx = validTx({
      solTransfers: [
        { from: ATTACKER, to: TRADING, lamports: 10_000_000_000n },
        { from: TRADING, to: JUPITER, lamports: 1_000n },
      ],
    });
    const outflow = policy.check(
      { intentId: nextIntent(), transaction: tx },
      validIntent,
      Date.now(),
    );
    expect(outflow).toBe(1_000n);
  });
});

describe("Keystore", () => {
  const fakeSecret = new Uint8Array(64).fill(7);

  it("gibt den Schluessel nicht ueber toString heraus", () => {
    const ks = Keystore.fromBytes(fakeSecret, "PubKey1");
    expect(String(ks)).toBe("[Keystore]");
    expect(`${ks}`).not.toContain("7,7,7");
  });

  it("gibt den Schluessel nicht ueber JSON heraus", () => {
    const ks = Keystore.fromBytes(fakeSecret, "PubKey1");
    expect(JSON.stringify({ ks })).toBe('{"ks":"[Keystore]"}');
  });

  it("reicht den Schluessel nur an eine Funktion, ohne ihn zurueckzugeben", () => {
    const ks = Keystore.fromBytes(fakeSecret, "PubKey1");
    expect(ks.withKey((s) => s.length)).toBe(64);
    // Kein Getter, kein Feld, kein Weg an die Bytes ausser withKey.
    expect(Object.keys(ks)).toEqual(["publicKey"]);
  });
});
