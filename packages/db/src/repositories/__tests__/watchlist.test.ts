import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { tokens } from "../../schema/index";
import { ensureWatchlistTokens, parseWatchlist, WATCHLIST_SOURCE } from "../watchlist";

/**
 * Die Watchlist.
 *
 * Ohne einen einzigen Token in der Tabelle meldet die Marktdaten-Aufnahme
 * dauerhaft `NO_TOKENS`, und die ganze Kette dahinter bleibt leer. Diese Datei
 * prueft, dass die Watchlist das behebt — und dabei nichts ueber die Token
 * behauptet.
 */

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("Zerlegen der Konfiguration", () => {
  it("liest eine kommagetrennte Liste", () => {
    expect(parseWatchlist(`${SOL},${USDC}`).mints).toEqual([SOL, USDC]);
  });

  it("vertraegt Leerzeichen und leere Eintraege", () => {
    expect(parseWatchlist(` ${SOL} , , ${USDC} ,`).mints).toEqual([SOL, USDC]);
  });

  it("meldet ungueltige Adressen, statt sie zu schlucken", () => {
    // Ein Tippfehler soll beim Start auffallen und nicht dadurch, dass ein
    // Token nie Daten bekommt.
    const r = parseWatchlist(`${SOL},nicht-base58!,${USDC}`);
    expect(r.mints).toEqual([SOL, USDC]);
    expect(r.rejected).toEqual(["nicht-base58!"]);
  });

  it("entfernt Wiederholungen", () => {
    expect(parseWatchlist(`${SOL},${SOL}`).mints).toEqual([SOL]);
  });

  it("nimmt eine fehlende oder leere Angabe hin", () => {
    expect(parseWatchlist(undefined).mints).toEqual([]);
    expect(parseWatchlist("   ").mints).toEqual([]);
  });
});

describe("Anlegen in der Datenbank", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
  });
  afterEach(async () => {
    await close();
  });

  it("legt die Token an und kennzeichnet ihre Herkunft", async () => {
    const r = await ensureWatchlistTokens({ db, raw: `${SOL},${USDC}` });
    expect(r.added).toBe(2);

    const rows = await db.select().from(tokens);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.discoverySource).toBe(WATCHLIST_SOURCE);
      expect(row.state).toBe("DISCOVERED");
      // Nichts behauptet: keine Dezimalstellen, kein Symbol, keine Bewertung.
      // Die Dezimalstellen stehen im Mint-Account on-chain, nicht in einer
      // Konfiguration — eine geratene waere im Ausfuehrungspfad ein
      // Betragsfehler um Zehnerpotenzen.
      expect(row.decimals).toBeNull();
      expect(row.symbol).toBeNull();
    }
  });

  it("laeuft ein zweites Mal ohne Dubletten", async () => {
    // Die Watchlist wird bei jedem Start angewendet.
    await ensureWatchlistTokens({ db, raw: SOL });
    const zweiter = await ensureWatchlistTokens({ db, raw: SOL });

    expect(zweiter.added).toBe(0);
    expect(zweiter.known).toBe(1);
    expect(await db.select().from(tokens)).toHaveLength(1);
  });

  it("setzt einen bereits bekannten Token nicht zurueck", async () => {
    // Ein Token, das die Discovery spaeter selbst findet, behaelt seine
    // urspruengliche Herkunft und seinen Zustand.
    await db.insert(tokens).values({
      mint: SOL,
      discoverySource: "NEW_PAIR",
      state: "CANDIDATE",
      decimals: 9,
    });

    await ensureWatchlistTokens({ db, raw: SOL });

    const [row] = await db.select().from(tokens);
    expect(row?.discoverySource).toBe("NEW_PAIR");
    expect(row?.state).toBe("CANDIDATE");
    expect(row?.decimals).toBe(9);
  });

  it("legt bei leerer Konfiguration nichts an", async () => {
    const r = await ensureWatchlistTokens({ db, raw: undefined });
    expect(r.added).toBe(0);
    expect(await db.select().from(tokens)).toHaveLength(0);
  });

  it("legt die gueltigen an und meldet die ungueltigen", async () => {
    const r = await ensureWatchlistTokens({ db, raw: `${SOL},kaputt` });
    expect(r.added).toBe(1);
    expect(r.rejected).toEqual(["kaputt"]);
  });
});
