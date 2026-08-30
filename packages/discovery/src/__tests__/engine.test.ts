import { describe, expect, it } from "vitest";
import { FixedClock, type Mint } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { InMemorySeenStore } from "../dedup";
import { runDiscovery, type DiscoveryRunInput } from "../engine";
import {
  SRC_A,
  SRC_B,
  T0,
  discovered,
  fakeSource,
  failingSource,
  mintOf,
  val,
} from "./fixtures";

const input = (overrides: Partial<DiscoveryRunInput> = {}): DiscoveryRunInput => ({
  sources: [fakeSource()],
  since: new Date(T0.getTime() - 600_000),
  store: new InMemorySeenStore(),
  clock: new FixedClock(T0),
  parameters: DEFAULT_STRATEGY_PARAMETERS,
  isBlacklisted: async () => false,
  checkAuthorities: async () => ({
    mintAuthorityActive: val(false),
    freezeAuthorityActive: val(false),
  }),
  ...overrides,
});

describe("runDiscovery", () => {
  it("liefert einen sauberen Token als Kandidaten", async () => {
    const result = await runDiscovery(input());
    expect(result.candidates).toHaveLength(1);
    expect(result.totalSeen).toBe(1);
  });

  it("sammelt aus mehreren Quellen", async () => {
    const result = await runDiscovery(
      input({
        sources: [
          fakeSource(SRC_A, [discovered({ mint: mintOf(1) })]),
          fakeSource(SRC_B, [discovered({ mint: mintOf(2), source: SRC_B })]),
        ],
      }),
    );
    expect(result.candidates).toHaveLength(2);
  });

  it("laeuft weiter, wenn eine Quelle ausfaellt", async () => {
    const result = await runDiscovery(input({ sources: [fakeSource(), failingSource()] }));
    expect(result.candidates).toHaveLength(1);
  });

  it("benennt ausgefallene Quellen, statt sie zu verschweigen", async () => {
    // Eine ausgefallene Quelle bedeutet unvollstaendige Abdeckung. Das muss im
    // Dashboard sichtbar sein — sonst sieht ein duenner Lauf aus wie ein ruhiger
    // Markt.
    const result = await runDiscovery(input({ sources: [fakeSource(), failingSource()] }));
    expect(result.failedSources).toHaveLength(1);
    expect(result.failedSources[0]).toContain("PROVIDER_DOWN");
  });

  it("ueberspringt bereits bekannte Tokens", async () => {
    const store = new InMemorySeenStore();
    await runDiscovery(input({ store }));
    const second = await runDiscovery(input({ store }));
    expect(second.candidates).toHaveLength(0);
    expect(second.duplicatesSkipped).toBe(1);
  });

  it("zaehlt die Ablehnungsgruende", async () => {
    const result = await runDiscovery(
      input({
        sources: [fakeSource(SRC_A, [discovered({ liquidityUsd: val(500) })])],
      }),
    );
    expect(result.rejected.get("LIQUIDITY_TOO_LOW")).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it("setzt vorlaeufig gescheiterte Tokens auf die Beobachtungsliste", async () => {
    const result = await runDiscovery(
      input({ sources: [fakeSource(SRC_A, [discovered({ liquidityUsd: val(500) })])] }),
    );
    expect(result.watchlist).toHaveLength(1);
  });

  it("setzt endgueltig ausgeschlossene Tokens NICHT auf die Beobachtungsliste", async () => {
    const result = await runDiscovery(
      input({
        checkAuthorities: async () => ({
          mintAuthorityActive: val(true),
          freezeAuthorityActive: val(false),
        }),
      }),
    );
    expect(result.watchlist).toHaveLength(0);
    expect(result.rejected.get("MINT_AUTHORITY_ACTIVE")).toBe(1);
  });

  it("prueft die Autoritaeten nur fuer neue Tokens", async () => {
    // Die Pruefung kostet je Mint einen RPC-Aufruf. Sie fuer laengst bekannte
    // Tokens zu wiederholen ist reine Budgetverschwendung.
    const store = new InMemorySeenStore();
    let calls = 0;
    const counting = async (_mint: Mint) => {
      calls += 1;
      return { mintAuthorityActive: val(false), freezeAuthorityActive: val(false) };
    };
    await runDiscovery(input({ store, checkAuthorities: counting }));
    await runDiscovery(input({ store, checkAuthorities: counting }));
    expect(calls).toBe(1);
  });

  it("kommt ohne Quellen zurecht", async () => {
    const result = await runDiscovery(input({ sources: [] }));
    expect(result.candidates).toEqual([]);
    expect(result.totalSeen).toBe(0);
  });
});
