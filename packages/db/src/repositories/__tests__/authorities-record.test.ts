import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { tokens, tokenSecurity } from "../../schema/index";
import { recordAuthorities } from "../discovery";

/**
 * Autoritaeten fortschreiben — und vor allem: NICHT bei jedem Takt.
 *
 * Die Discovery laeuft alle 30 Sekunden und liest die Autoritaeten ohnehin.
 * Sie jedes Mal zu schreiben ergaebe 2.880 identische Zeilen je Token und Tag
 * — derselbe Leerlauf wie in DECISIONS §101, nur in Schreibrichtung. Eine
 * Aenderung dagegen ist ein Ereignis und gehoert festgehalten.
 */

const T0 = new Date("2026-09-10T12:00:00Z");
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  await db
    .insert(tokens)
    .values({ mint: MEME, discoverySource: "dexscreener", state: "SCREENING" });
});
afterAll(async () => {
  await close();
});

const harmlos = [{ mint: MEME, mintAuthorityActive: false, freezeAuthorityActive: false }];

describe("Autoritaeten fortschreiben", () => {
  it("schreibt beim ersten Mal eine Zeile", async () => {
    expect(await recordAuthorities(db, harmlos, "v1", T0)).toBe(1);
  });

  it("schreibt beim zweiten Mal KEINE zweite", async () => {
    const spaeter = new Date(T0.getTime() + 30_000);
    expect(await recordAuthorities(db, harmlos, "v1", spaeter)).toBe(0);

    const alle = await db.select({ id: tokenSecurity.id }).from(tokenSecurity);
    expect(alle).toHaveLength(1);
  });

  it("schreibt bei einer AENDERUNG sehr wohl", async () => {
    // Der Fall, um den es geht: jemand hat die Mint-Autoritaet wieder
    // aktiviert. Das ist die Voraussetzung fuer beliebiges Nachpraegen und
    // darf nicht im Rauschen untergehen.
    const gefaehrlich = [{ mint: MEME, mintAuthorityActive: true, freezeAuthorityActive: false }];
    const spaeter = new Date(T0.getTime() + 60_000);
    expect(await recordAuthorities(db, gefaehrlich, "v1", spaeter)).toBe(1);

    const alle = await db.select({ id: tokenSecurity.id }).from(tokenSecurity);
    expect(alle).toHaveLength(2);
  });

  it("ueberspringt einen Mint, den es als Token gar nicht gibt", async () => {
    // Kein Wurf: die Discovery kann einen Mint gelesen haben, der danach
    // verworfen wurde. Ein Fremdschluesselfehler wuerde den ganzen Lauf
    // mitreissen.
    const fremd = [
      { mint: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", mintAuthorityActive: false, freezeAuthorityActive: false },
    ];
    expect(await recordAuthorities(db, fremd, "v1", T0)).toBe(0);
  });

  it("macht bei leerer Liste gar nichts", async () => {
    expect(await recordAuthorities(db, [], "v1", T0)).toBe(0);
  });
});
