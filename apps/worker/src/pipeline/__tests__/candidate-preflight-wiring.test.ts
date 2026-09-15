import { createLogger } from "@sae/observability";
import { monitorPaperPositions } from "../position-monitor";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { bps, eur, money, observed, providerId } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { schema } from "@sae/db";
import { createHarness } from "./harness";
import { testFixtureRequest } from "../test-fixture";
import { runOpportunityPipeline } from "../opportunity-pipeline";
import { preparePaperEntry } from "../prepare-paper-entry";
import { reconcilePaperAccount } from "../paper-account";
import { ensurePaperCandidateVersion } from "../paper-candidate-version";

const at = new Date("2026-09-14T12:00:00Z");
it("connects lazy preflight to the exact risk-sized position without affecting rejected signals", async () => {
  const h = await createHarness(at);
  try {
    await h.db.update(schema.strategyVersions).set({ parameters: MEMECOIN_PAPER_CANDIDATE.parameters })
      .where(eq(schema.strategyVersions.id, h.strategyVersionId));
    let preparations = 0;
    const deps = h.deps({ parameters: MEMECOIN_PAPER_CANDIDATE.parameters });
    const prepareEntry = async () => {
      preparations++;
      return preparePaperEntry({ account: reconcilePaperAccount({ initialCash: eur(3000), positions: [], events: [], asOf: at }),
        valuation: { solPrice: eur(100),
          preparePurchase: (budget) => ({ amountRaw: budget.minor * 10000n, notional: budget, observedAt: at, source: "TEST_FIXTURE" }),
          valueFill: async ({ amountRaw, currency }) => ({ proceeds: money(amountRaw / 10000n, currency), observedAt: at, source: "TEST_FIXTURE" }) },
        quotes: { quote: async (plan) => observed({ outAmount: plan.inAmount, priceImpactBps: bps(0) }, providerId("TEST_FIXTURE"), at) },
        clock: h.clock, parameters: deps.parameters, inputMint: deps.inputMint, outputMint: deps.outputMint,
        tokenId: h.tokenId, context: deps.decisionContext, random: () => 1 });
    };
    const rejected = await runOpportunityPipeline(testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "rejected" }), {
      ...deps, prepareEntry, decisionContext: { ...deps.decisionContext, tokenBlacklisted: true },
    });
    expect(rejected.kind).toBe("NO_ENTRY");
    expect(preparations).toBe(0);
    h.clock.set(new Date(at.getTime() + 1));
    const result = await runOpportunityPipeline(testFixtureRequest({ tokenId: h.tokenId, asOf: h.clock.now(), label: "prepared" }), { ...deps, prepareEntry });
    expect(result.kind).toBe("ENTERED");
    if (result.kind === "ENTERED") expect(result.autoPosition.kind).toBe("OPENED");
    expect(preparations).toBe(1);
    const positions = await h.db.select().from(schema.paperPositions);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ entryNotionalMinor: 1875n, entryAmountRaw: 18750000n, sizingMode: "RISK_BASED", isTestFixture: true });
    // Complete lifecycle uses isolated fixture rows, never performance evidence.
    const snapshot = async (price: number, time: Date, key: string) => h.db.insert(schema.tokenSnapshots).values({
      tokenId: h.tokenId, observedAt: time, priceUsd: price, liquidityUsd: 180000, dataCompleteness: 1,
      sourceProviderId: "TEST_FIXTURE", sourceTier: "PRIMARY", ingestKey: key,
    });
    await snapshot(1, h.clock.now(), "candidate-entry");
    const monitor = () => monitorPaperPositions({ db: h.db, clock: h.clock, quoteMint: deps.inputMint,
      logger: createLogger({ service: "test", level: "error" }), solPrice: eur(100), random: () => 1,
      quotes: { quote: async (plan) => observed({ outAmount: plan.inAmount, priceImpactBps: bps(0) }, providerId("TEST_FIXTURE"), h.clock.now()) },
      valueFill: async ({ amountRaw, currency, at: valuedAt }) => ({ proceeds: money(amountRaw / 10000n, currency), observedAt: valuedAt, source: "TEST_FIXTURE" }),
    });
    h.clock.set(new Date(at.getTime() + 60000));
    await snapshot(1.3, h.clock.now(), "candidate-partial");
    await monitor();
    const [partial] = await h.db.select().from(schema.paperPositions);
    expect(partial?.remainingAmountRaw).toBe(11250000n);
    h.clock.set(new Date(at.getTime() + 120000));
    await snapshot(.7, h.clock.now(), "candidate-stop");
    expect((await monitor()).closed).toBe(1);
    const [closed] = await h.db.select().from(schema.paperPositions);
    expect(closed?.remainingAmountRaw).toBe(0n);
    expect(closed?.realizedPnlMinor).toBe(0n); // Quote proceeds, not the signal price ratio.
    expect(closed!.costsPaidMinor).toBeGreaterThan(0n);

  } finally { await h.close(); }
});

it("creates a separate immutable candidate version and refuses mismatching stored parameters", async () => {
  const h = await createHarness(at);
  try {
    const one = await ensurePaperCandidateVersion(h.db, at);
    const two = await ensurePaperCandidateVersion(h.db, at);
    expect(one.id).toBe(two.id);
    expect(one.id).not.toBe(h.strategyVersionId);
    expect(two.created).toBe(false);
    await h.db.update(schema.strategyVersions).set({ parameters: {} }).where(eq(schema.strategyVersions.id, one.id));
    await expect(ensurePaperCandidateVersion(h.db, at)).rejects.toThrow("differs or is retired");
    const [row] = await h.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, one.id));
    expect(row?.parameters).toEqual({});
  } finally { await h.close(); }
});
