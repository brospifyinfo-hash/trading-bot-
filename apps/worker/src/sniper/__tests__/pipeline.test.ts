import { expect, it } from "vitest";
import { missing } from "@sae/core";
import { paperCandidate } from "@sae/config";
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
    const deps = h.deps({ parameters: paperCandidate(50).parameters });
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

/**
 * Der Regler wirkt — und er wirkt NUR auf die Einstiegsschwelle.
 *
 * Vorher verglich dieser Test zwei Profile miteinander. Es gibt nur noch
 * eines, und die interessante Frage ist eine andere geworden: aendert die
 * eingestellte Zahl am Ende wirklich die Entscheidung, oder sieht sie nur so
 * aus? Dieselbe Beobachtung, zwei Schwellen, zwei Ergebnisse.
 *
 * Die Kaufdruck-Pruefung bleibt dabei in beiden Faellen unveraendert — sie
 * misst etwas anderes als der Endscore und darf nicht mitwandern.
 */
it("entscheidet dieselbe Beobachtung je nach eingestellter Schwelle anders", async () => {
  const { observed, providerId } = await import("@sae/core");
  const at = new Date("2026-10-01T00:00:00Z"), h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "entry-score-test" });
    // Minderheit auf der Kaufseite: 2 von 5 Trades, also ein Kaufanteil von
    // 0,4 — ueber den verlangten 0,30 und mit mindestens einem Kauf.
    const features = { ...request.features, momentum: { ...request.features.momentum,
      buys5m: observed(2, providerId("test"), at), sells5m: observed(3, providerId("test"), at) } };

    const tief = h.deps({ parameters: paperCandidate(35).parameters });
    expect((await runOpportunityPipeline({ ...request, features }, tief)).kind).toBe("ENTERED");

    // Dieselben Daten, nur die Schwelle hoeher: kein Einstieg, und der Grund
    // ist der Score — nicht etwa ein stillschweigend mitgezogenes Tor.
    h.clock.set(new Date(at.getTime() + 1_000));
    const hoch = h.deps({ parameters: paperCandidate(95).parameters });
    const ergebnis = await runOpportunityPipeline(
      { ...request, features: { ...features, asOf: h.clock.now() } }, hoch);
    expect(ergebnis.kind).toBe("NO_ENTRY");
    if (ergebnis.kind === "NO_ENTRY") expect(ergebnis.decision.kind).not.toBe("ENTER");

    expect(await runOpportunityPipeline({ ...request, features }, { ...tief, decisionContext: { ...tief.decisionContext, executionMode: "live" } }))
      .toMatchObject({ kind: "BLOCKED", reason: "PAPER_ONLY_MODEL" });
  } finally { await h.close(); }
}, 30000);

/**
 * Zu wenig Kaufdruck bleibt zu wenig Kaufdruck, egal wie tief die Schwelle steht.
 *
 * Die Gefahr bei einem freien Regler ist, dass er heimlich mehr aufmacht als
 * die eine Zahl. Null Kaeufe sind kein Einstieg, auch bei Schwelle 10.
 */
it("laesst den Kaufdruck-Gate von der Schwelle unberuehrt", async () => {
  const { observed, providerId } = await import("@sae/core");
  const at = new Date("2026-10-01T00:00:00Z"), h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "buy-pressure-test" });
    const features = { ...request.features, momentum: { ...request.features.momentum,
      buys5m: observed(0, providerId("test"), at), sells5m: observed(7, providerId("test"), at) } };
    for (const score of [10, 35, 95]) {
      expect(await runOpportunityPipeline({ ...request, features }, h.deps({ parameters: paperCandidate(score).parameters })))
        .toMatchObject({ kind: "BLOCKED", reason: "LAUNCH_BUY_PRESSURE" });
    }
  } finally { await h.close(); }
}, 30000);
