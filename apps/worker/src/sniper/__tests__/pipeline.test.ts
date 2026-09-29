import { expect, it } from "vitest";
import { missing } from "@sae/core";
import { MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE } from "@sae/config";
import { createHarness } from "../../pipeline/__tests__/harness";
import { testFixtureRequest } from "../../pipeline/test-fixture";
import { runOpportunityPipeline } from "../../pipeline/opportunity-pipeline";
it("paper launch reaches entry without historical prices but still blocks absent security", async () => {
  const at = new Date("2026-09-29T12:00:00Z"), h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "paper-sniper-test" });
    const features = { ...request.features, momentum: { ...request.features.momentum,
      priceChange5m: missing("NOT_YET_COLLECTED", at, null),
      priceChange1h: missing("NOT_YET_COLLECTED", at, null) } };
    const deps = h.deps({ parameters: MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE.parameters });
    const blocked = await runOpportunityPipeline({ ...request, features: { ...features,
      security: { ...features.security, mintAuthorityActive: missing("NOT_YET_COLLECTED", at, null) } } }, deps);
    expect(blocked.kind).toBe("NO_ENTRY");
    if (blocked.kind === "NO_ENTRY") expect(blocked.decision.rejectionReasons).toContain("DATA_INCOMPLETE");
    h.clock.set(new Date(at.getTime() + 1000));
    const entered = await runOpportunityPipeline({ ...request, features: { ...features, asOf: h.clock.now() } }, deps);
    expect(entered.kind, JSON.stringify(entered, (_k, v) => typeof v === "bigint" ? String(v) : v)).toBe("ENTERED");
    const live = await runOpportunityPipeline({ ...request, features }, { ...deps, decisionContext: { ...deps.decisionContext, executionMode: "live" } });
    expect(live).toMatchObject({ kind: "BLOCKED", reason: "PAPER_ONLY_MODEL" });
  } finally { await h.close(); }
}, 30000);
