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

/**
 * Der Offensiv-Modus, durch die ganze Kette.
 *
 * Der Betreiber will den Bot handeln sehen und nimmt eine duennere Grundlage
 * in Kauf. Geprueft wird hier beides: dass es wirkt — und dass es NICHT zu
 * weit geht.
 */
it("steigt offensiv auch ohne Ausfuehrungsdaten ein, vorsichtig nicht", async () => {
  const { missing: fehlt } = await import("@sae/core");
  const at = new Date("2026-10-02T12:00:00Z"), h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "offensive-test" });
    // Genau das Bild aus dem Betrieb: der Router hat geschwiegen, also fehlen
    // Preiseinfluss, Ausstiegsfaehigkeit und die daraus gerechneten Kosten.
    const ohneRouter = { ...request.features, execution: {
      expectedCostBps: fehlt("NOT_YET_COLLECTED" as const, at, null),
      exitCapacityRatio: fehlt("NOT_YET_COLLECTED" as const, at, null),
      priceImpactBps: fehlt("NOT_YET_COLLECTED" as const, at, null),
    } };

    const vorsichtig = await runOpportunityPipeline(
      { ...request, features: ohneRouter },
      h.deps({ parameters: paperCandidate(10, "VORSICHTIG").parameters }),
    );
    expect(vorsichtig.kind).toBe("NO_ENTRY");
    if (vorsichtig.kind === "NO_ENTRY") {
      expect(vorsichtig.decision.rejectionReasons).toContain("DATA_INCOMPLETE");
    }

    h.clock.set(new Date(at.getTime() + 1_000));
    const offensiv = await runOpportunityPipeline(
      { ...request, features: { ...ohneRouter, asOf: h.clock.now() } },
      h.deps({ parameters: paperCandidate(10, "OFFENSIV").parameters }),
    );
    expect(offensiv.kind, JSON.stringify(offensiv, (_k, v) => typeof v === "bigint" ? String(v) : v)).toBe("ENTERED");
  } finally { await h.close(); }
}, 30000);

it("bleibt offensiv NUR auf Papier", async () => {
  // Mit unvollstaendigen Daten zu entscheiden ist auf Papier eine
  // Beobachtungsentscheidung und im Live-Handel eine Fehlkonfiguration.
  const at = new Date("2026-10-02T12:00:00Z"), h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "offensive-live" });
    const deps = h.deps({ parameters: paperCandidate(10, "OFFENSIV").parameters });
    expect(await runOpportunityPipeline(request, { ...deps,
      decisionContext: { ...deps.decisionContext, executionMode: "live" } }))
      .toMatchObject({ kind: "BLOCKED", reason: "PAPER_ONLY_MODEL" });
  } finally { await h.close(); }
}, 30000);

it("laesst offensiv die vier gemessenen Sicherheitsbefunde NICHT durch", async () => {
  // Fehlende Daten halten nicht auf. Ein Token, bei dem nachweislich jemand
  // beliebig nachpraegen kann, ist aber keine Wissenslucke, sondern ein
  // Befund — und bleibt ausgeschlossen.
  const { observed, providerId } = await import("@sae/core");
  const at = new Date("2026-10-02T12:00:00Z"), h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "offensive-security" });
    const deps = h.deps({ parameters: paperCandidate(10, "OFFENSIV").parameters });
    const faelle = [
      ["mintAuthorityActive", "MINT_AUTHORITY_ACTIVE"],
      ["freezeAuthorityActive", "FREEZE_AUTHORITY_ACTIVE"],
    ] as const;
    for (const [feld, grund] of faelle) {
      h.clock.set(new Date(at.getTime() + 1_000));
      const result = await runOpportunityPipeline({ ...request, features: {
        ...request.features, asOf: h.clock.now(),
        security: { ...request.features.security, [feld]: observed(true, providerId("test"), at) },
      } }, deps);
      expect(result.kind).toBe("NO_ENTRY");
      if (result.kind === "NO_ENTRY") expect(result.decision.rejectionReasons).toContain(grund);
    }
  } finally { await h.close(); }
}, 30000);
