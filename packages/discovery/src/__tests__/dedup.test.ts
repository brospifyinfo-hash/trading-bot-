import { describe, expect, it } from "vitest";
import { InMemorySeenStore, deduplicate } from "../dedup";
import { SRC_A, SRC_B, T0, discovered, mintOf } from "./fixtures";

describe("deduplicate", () => {
  it("laesst einen neuen Token durch", async () => {
    const store = new InMemorySeenStore();
    const result = await deduplicate([discovered()], store);
    expect(result.fresh).toHaveLength(1);
    expect(result.duplicates).toBe(0);
  });

  it("filtert einen bereits bekannten Token", async () => {
    // Ohne das laeuft die teure Anreicherung bei jedem Abruf erneut — der
    // schnellste Weg, ein Provider-Budget zu verbrennen.
    const store = new InMemorySeenStore();
    await deduplicate([discovered()], store);
    const second = await deduplicate([discovered()], store);
    expect(second.fresh).toHaveLength(0);
    expect(second.duplicates).toBe(1);
  });

  it("fasst Meldungen mehrerer Quellen zum selben Mint zusammen", async () => {
    const store = new InMemorySeenStore();
    const result = await deduplicate(
      [discovered({ source: SRC_A }), discovered({ source: SRC_B })],
      store,
    );
    expect(result.fresh).toHaveLength(1);
    expect(store.size).toBe(1);
  });

  it("haelt fest, wenn mehrere Quellen denselben Token melden", async () => {
    // Das ist eine Information fuer die Priorisierung, NICHT fuer die Bewertung.
    // Aufmerksamkeit ist kein Qualitaetsmerkmal.
    const store = new InMemorySeenStore();
    const result = await deduplicate(
      [discovered({ source: SRC_A }), discovered({ source: SRC_B })],
      store,
    );
    expect(result.multiSourceMints).toEqual([mintOf(1)]);
  });

  it("behaelt den fruehesten Beobachtungszeitpunkt", async () => {
    // Wir wollen wissen, wann wir den Token ZUERST gesehen haben — nicht, wann
    // ihn die langsamste Quelle gemeldet hat.
    const store = new InMemorySeenStore();
    const later = new Date(T0.getTime() + 600_000);
    const result = await deduplicate(
      [discovered({ observedAt: later, source: SRC_B }), discovered({ observedAt: T0 })],
      store,
    );
    expect(result.fresh[0]!.observedAt).toEqual(T0);
  });

  it("unterscheidet verschiedene Mints", async () => {
    const store = new InMemorySeenStore();
    const result = await deduplicate(
      [discovered({ mint: mintOf(1) }), discovered({ mint: mintOf(2) })],
      store,
    );
    expect(result.fresh).toHaveLength(2);
  });

  it("kommt mit einer leeren Charge zurecht", async () => {
    const result = await deduplicate([], new InMemorySeenStore());
    expect(result.fresh).toEqual([]);
    expect(result.duplicates).toBe(0);
  });
});
