import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";

import { enrichSecurity } from "../security-enrichment";

/**
 * Der Anreicherungstakt.
 *
 * Geprueft wird vor allem, wann NICHTS geschrieben wird. Eine Zeile in
 * `token_security` ohne echte Werte saehe im Feature-Vektor aus wie „geprueft
 * und unauffaellig" — das waere die gefaehrlichste Luege, die dieses System
 * erzaehlen koennte, und ausgerechnet an der Stelle, an der es um Rug Pulls
 * geht.
 */

const T0 = new Date("2026-09-11T12:00:00Z");
const BASE = "https://rugcheck.invalid";
const logger = createLogger({ service: "test", level: "error" });
const MEME = "7jAxKsGdGS3T9w4pntSN7fgn6iCF65uk3XDZqxzapump";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(schema.tokenSecurity);
  await db.delete(schema.tokens);
  await db
    .insert(schema.tokens)
    .values({ mint: MEME, discoverySource: "dexscreener", state: "SCREENING" });
});

/** Ein Bericht in der gemessenen Form, gekuerzt auf das Noetige. */
function bericht(): unknown {
  return {
    mint: MEME,
    token: {
      supply: 633335122268411,
      decimals: 6,
      mintAuthority: null,
      freezeAuthority: null,
    },
    creator: "AhVn2ve",
    topHolders: [
      { address: "EWYJ", pct: 41.92, owner: "7ZYnU2wr" },
      { address: "73TE", pct: 17.48, owner: "DZAvUwwv" },
      { address: "7dRw", pct: 11.45, owner: "DZAvUwwv" },
      { address: "EatJ", pct: 0.49, owner: "AhVn2ve" },
    ],
    knownAccounts: { "7ZYnU2wr": { name: "Pump Fun AMM", type: "AMM" } },
    markets: [{ lp: { lpLockedPct: 72.886 } }],
    risks: [{ name: "High holder concentration", level: "warn" }],
    score: 1038,
    score_normalised: 22,
    rugged: false,
    totalHolders: 335,
  };
}

function netz(
  antwort: () => { status: number; body?: unknown; headers?: Record<string, string> },
): typeof fetch {
  return (async () => {
    const a = antwort();
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), {
      status: a.status,
      headers: a.headers ?? {},
    });
  }) as unknown as typeof fetch;
}

describe("Sicherheitsbefunde nachladen", () => {
  it("schreibt gar nichts ohne konfigurierten Anbieter", async () => {
    // Kein Anbieter, kein Befund — und ausdruecklich keine leere Zeile.
    const result = await enrichSecurity({ db, logger, clock: new FixedClock(T0) });
    expect(result.status).toBe("NOT_CONFIGURED");

    const rows = await db.select({ id: schema.tokenSecurity.id }).from(schema.tokenSecurity);
    expect(rows).toHaveLength(0);
  });

  it("schreibt die Konzentration OHNE den Liquiditaetspool", async () => {
    const result = await enrichSecurity({
      db,
      logger,
      clock: new FixedClock(T0),
      baseUrl: BASE,
      fetchImpl: netz(() => ({
        status: 200,
        body: bericht(),
        headers: { "x-rate-limit-limit": "15", "x-rate-limit-remaining": "14" },
      })),
    });

    expect(result.status).toBe("OK");
    expect(result.written).toBe(1);
    expect(result.rateLimitRemaining).toBe(14);

    const [row] = await db
      .select({
        top10: schema.tokenSecurity.top10HolderSharePct,
        top: schema.tokenSecurity.topHolderSharePct,
        dev: schema.tokenSecurity.devHoldingPct,
        mint: schema.tokenSecurity.mintAuthorityActive,
        freeze: schema.tokenSecurity.freezeAuthorityActive,
        score: schema.tokenSecurity.securityScore,
        findings: schema.tokenSecurity.findings,
      })
      .from(schema.tokenSecurity)
      .limit(1);

    // Roh waeren es 71,34 % ueber vier Konten. Ohne Pool und nach Besitzern
    // zusammengefasst: 28,93 + 0,49 = 29,42 %.
    expect(row?.top10).toBeCloseTo(29.42, 2);
    expect(row?.top).toBeCloseTo(28.93, 2);
    expect(row?.dev).toBeCloseTo(0.49, 2);
    expect(row?.mint).toBe(false);
    expect(row?.freeze).toBe(false);
    expect(row?.score).toBe(22);

    // Der LP-Anteil hat keine Spalte und bekommt keine erfundene Schwelle —
    // er landet unveraendert in den Befunden.
    expect((row?.findings as { lpLockedPct?: number }).lpLockedPct).toBeCloseTo(72.886, 3);
  });

  it("haelt bei Drosselung sofort an", async () => {
    // Weitermachen wuerde denselben Fehler erzeugen und den Rest tiefer ins
    // Limit treiben. In fuenf Minuten laeuft der Takt ohnehin wieder.
    let aufrufe = 0;
    await db
      .insert(schema.tokens)
      .values({ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", discoverySource: "x", state: "SCREENING" });

    const result = await enrichSecurity({
      db,
      logger,
      clock: new FixedClock(T0),
      baseUrl: BASE,
      fetchImpl: netz(() => {
        aufrufe += 1;
        return { status: 429, headers: { "x-rate-limit-remaining": "0" } };
      }),
    });

    expect(result.written).toBe(0);
    expect(aufrufe).toBe(1);
    expect(result.outcomes["RATE_LIMITED"]).toBe(1);
  });

  it("schreibt nichts bei einer unlesbaren Antwort", async () => {
    const result = await enrichSecurity({
      db,
      logger,
      clock: new FixedClock(T0),
      baseUrl: BASE,
      fetchImpl: netz(() => ({ status: 200, body: { mint: MEME } })),
    });
    expect(result.written).toBe(0);
    expect(result.outcomes["SCHEMA_REJECTED"]).toBe(1);

    const rows = await db.select({ id: schema.tokenSecurity.id }).from(schema.tokenSecurity);
    expect(rows).toHaveLength(0);
  });

  it("fragt einen frisch geprueften Token nicht erneut", async () => {
    const clock = new FixedClock(T0);
    const fetchImpl = netz(() => ({ status: 200, body: bericht() }));

    const erster = await enrichSecurity({ db, logger, clock, baseUrl: BASE, fetchImpl });
    expect(erster.written).toBe(1);

    // Eine Stunde spaeter: der Befund ist noch frisch, es gibt nichts zu tun.
    clock.advance(60 * 60 * 1_000);
    const zweiter = await enrichSecurity({ db, logger, clock, baseUrl: BASE, fetchImpl });
    expect(zweiter.status).toBe("NO_TOKENS");
  });

  it("fragt nach Ablauf der Frist wieder", async () => {
    const clock = new FixedClock(T0);
    const fetchImpl = netz(() => ({ status: 200, body: bericht() }));

    await enrichSecurity({ db, logger, clock, baseUrl: BASE, fetchImpl });
    // Sieben Stunden — die Frist liegt bei sechs.
    clock.advance(7 * 60 * 60 * 1_000);
    const zweiter = await enrichSecurity({ db, logger, clock, baseUrl: BASE, fetchImpl });

    expect(zweiter.written).toBe(1);
    // Zwei Zeilen: ein Befund ist eine Messung zu einem Zeitpunkt, und die
    // Zeitreihe ist der Zweck.
    const rows = await db.select({ id: schema.tokenSecurity.id }).from(schema.tokenSecurity);
    expect(rows).toHaveLength(2);
  });
});
