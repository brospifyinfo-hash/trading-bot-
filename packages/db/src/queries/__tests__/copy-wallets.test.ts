import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import {
  MAX_COPY_WALLETS,
  addCopyWallets,
  loadActiveCopyWallets,
  loadCopyWallets,
  markCopyWalletChecked,
  parseWalletList,
  removeCopyWallet,
  setCopyWalletActive,
} from "../copy-wallets";

/**
 * Die Vorbild-Wallets.
 *
 * Eingeklebt wird unsauber — das ist der Normalfall und kein Bedienfehler.
 * Diese Tests halten fest, dass das Einlesen verzeiht, wo es verzeihen kann,
 * und meldet, wo Raten gefaehrlich waere: eine falsch uebernommene Adresse
 * kopiert still die Trades eines Fremden.
 */

const A = "7igLKzSzdFWZwno55o7n9pesZyG1Ban4QCXLkaeweWuy";
const B = "So11111111111111111111111111111111111111112";
const C = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

describe("Einkleben", () => {
  it("nimmt eine Adresse pro Zeile", () => {
    const r = parseWalletList(`${A}\n${B}\n`);
    expect(r.gueltig.map((w) => w.address)).toEqual([A, B]);
    expect(r.ungueltig).toEqual([]);
  });

  it("nimmt mehrere in einer Zeile, egal mit welchem Trenner", () => {
    expect(parseWalletList(`${A}, ${B};${C}`).gueltig).toHaveLength(3);
    expect(parseWalletList(`${A}\t${B}`).gueltig).toHaveLength(2);
  });

  it("macht aus fuenf Adressen in einer Zeile NICHT eine mit Namen", () => {
    // Die naheliegende Regel „erstes Wort ist die Adresse, der Rest der Name"
    // haette hier zwei Wallets zu einer gemacht — und niemand haette es
    // gemerkt, weil die Liste danach plausibel aussieht.
    const r = parseWalletList(`${A} ${B}`);
    expect(r.gueltig).toHaveLength(2);
    expect(r.gueltig[0]!.label).toBeNull();
  });

  it("nimmt einen Namen nur in der ausdruecklichen Form", () => {
    expect(parseWalletList(`${A} = Alpha-Wallet`).gueltig[0]).toEqual({
      address: A, label: "Alpha-Wallet",
    });
    expect(parseWalletList(`${A} | Zweite`).gueltig[0]?.label).toBe("Zweite");
    expect(parseWalletList(`${A} =   `).gueltig[0]?.label).toBeNull();
  });

  it("holt die Adresse aus einem Link", () => {
    const r = parseWalletList(`https://solscan.io/account/${A}\n`);
    expect(r.gueltig.map((w) => w.address)).toEqual([A]);
  });

  it("raet nicht, wenn ein Link zwei Adressen enthaelt", () => {
    const r = parseWalletList(`https://x.de/${A}/swap/${B}`);
    expect(r.gueltig).toEqual([]);
    expect(r.ungueltig).toHaveLength(1);
  });

  it("meldet, was keine Adresse ist, statt es zu verschlucken", () => {
    const r = parseWalletList(`${A}\nvielleicht-eine-wallet-aber-zu-kurz\n`);
    expect(r.gueltig.map((w) => w.address)).toEqual([A]);
    expect(r.ungueltig).toEqual(["vielleicht-eine-wallet-aber-zu-kurz"]);
  });

  it("meldet Doppelte innerhalb derselben Eingabe", () => {
    const r = parseWalletList(`${A}\n${A}\n${B}`);
    expect(r.gueltig).toHaveLength(2);
    expect(r.doppelt).toEqual([A]);
  });

  it("ignoriert Leerzeilen und Satzzeichen am Rand", () => {
    const r = parseWalletList(`\n  "${A}",  \n\n(${B})\n`);
    expect(r.gueltig.map((w) => w.address)).toEqual([A, B]);
  });
});

describe("Anlegen", () => {
  it("legt an, uebernimmt Namen und meldet Bekannte", async () => {
    const erst = await addCopyWallets(db, parseWalletList(`${A} = Alpha`).gueltig, "dashboard");
    expect(erst.angelegt).toEqual([A]);
    expect(erst.gesamt).toBe(1);

    const zweit = await addCopyWallets(db, parseWalletList(`${A}\n${B}`).gueltig, "dashboard");
    expect(zweit.bekannt).toEqual([A]);
    expect(zweit.angelegt).toEqual([B]);

    const liste = await loadCopyWallets(db);
    // Der Name bleibt: die zweite Eingabe kam ohne, und ein leerer Name waere
    // ein Verlust ohne Absicht.
    expect(liste.find((w) => w.address === A)?.label).toBe("Alpha");
    expect(liste.every((w) => w.active)).toBe(true);
  });

  it("ueberschreibt den Namen, wenn ein neuer mitkommt", async () => {
    await addCopyWallets(db, [{ address: A, label: "Alt" }], "dashboard");
    await addCopyWallets(db, [{ address: A, label: "Neu" }], "dashboard");
    const liste = await loadCopyWallets(db);
    expect(liste[0]?.label).toBe("Neu");
  });

  it("haelt die Obergrenze und sagt, was nicht mehr hineinpasste", async () => {
    const viele = Array.from({ length: MAX_COPY_WALLETS + 3 }, (_, i) => ({
      // Base58 ohne 0, O, I, l — und genau 44 Zeichen lang.
      address: `${String(i + 11).padStart(2, "1")}${"1".repeat(42)}`,
      label: null,
    }));
    const r = await addCopyWallets(db, viele, "dashboard");
    expect(r.kind).toBe("LIMIT_REACHED");
    expect(r.angelegt).toHaveLength(MAX_COPY_WALLETS);
    expect(r.abgewiesen).toHaveLength(3);
    expect((await loadCopyWallets(db)).length).toBe(MAX_COPY_WALLETS);
  }, 60_000);
});

describe("Abschalten und Entfernen", () => {
  it("schaltet ab, ohne die Zeile zu verlieren", async () => {
    await addCopyWallets(db, [{ address: A, label: null }], "dashboard");
    expect(await setCopyWalletActive(db, A, false)).toBe(true);

    expect((await loadActiveCopyWallets(db))).toEqual([]);
    expect((await loadCopyWallets(db))).toHaveLength(1);
  });

  it("entfernt eine Wallet, von der noch nie kopiert wurde", async () => {
    await addCopyWallets(db, [{ address: A, label: null }], "dashboard");
    expect(await removeCopyWallet(db, A)).toBe("ENTFERNT");
    expect(await loadCopyWallets(db)).toEqual([]);
  });

  it("verweigert das Entfernen, sobald Trades daran haengen", async () => {
    await addCopyWallets(db, [{ address: A, label: null }], "dashboard");
    await markCopyWalletChecked(db, A, new Date("2026-10-04T12:00:00Z"), "sig-1", 2);

    // Die Zuordnung „dieser Trade kam von dieser Wallet" ist das Einzige, was
    // die Auswertung moeglich macht. Sie gegen eine Zeile zu tauschen waere
    // ein schlechter Tausch.
    expect(await removeCopyWallet(db, A)).toBe("HAT_TRADES");
    expect((await loadCopyWallets(db))[0]?.copiedCount).toBe(2);
  });

  it("meldet NICHT_GEFUNDEN bei unbekannter und bei unsinniger Adresse", async () => {
    expect(await removeCopyWallet(db, A)).toBe("NICHT_GEFUNDEN");
    expect(await removeCopyWallet(db, "kein-base58")).toBe("NICHT_GEFUNDEN");
    expect(await setCopyWalletActive(db, "kein-base58", false)).toBe(false);
  });
});

describe("Der Wasserstand des Kopierers", () => {
  it("laeuft nur vorwaerts", async () => {
    await addCopyWallets(db, [{ address: A, label: null }], "dashboard");
    const spaet = new Date("2026-10-04T12:00:00Z");
    const frueh = new Date("2026-10-04T10:00:00Z");

    await markCopyWalletChecked(db, A, spaet, "sig-spaet", 1);
    // Ein Rueckschritt wuerde dieselben Trades ein zweites Mal kopieren.
    await markCopyWalletChecked(db, A, frueh, "sig-frueh", 5);

    const [row] = await loadCopyWallets(db);
    expect(row?.lastCheckedAt?.toISOString()).toBe(spaet.toISOString());
    expect(row?.copiedCount).toBe(1);
  });

  it("beginnt bei einer neuen Wallet ohne Wasserstand", async () => {
    await addCopyWallets(db, [{ address: A, label: null }], "dashboard");
    const [row] = await loadCopyWallets(db);
    // `null` heisst „noch nie gelesen" — und der Kopierer faengt dann bei
    // JETZT an, nicht bei der ganzen Historie der Wallet.
    expect(row?.lastCheckedAt).toBeNull();
    expect(row?.copiedCount).toBe(0);
  });
});
