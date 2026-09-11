import { describe, expect, it } from "vitest";

import { labelOf } from "../decision-run";
import type { PipelineOutcome } from "../opportunity-pipeline";

/**
 * Das Etikett, unter dem eine Entscheidung im Log gezaehlt wird.
 *
 * Der Anlass ist eine Frage, die das Log nicht beantworten konnte: gezaehlt
 * wurde die Ergebnis-ART, also `NO_ENTRY=5`. Das sagt, dass die Kette lief und
 * nichts gekauft wurde — und verschweigt genau das, weswegen man hinsieht.
 *
 * Geprueft wird hier die Abbildung selbst, weil sie im Betrieb der einzige Weg
 * ist, eine Ablehnung zu verstehen, und weil sie still falsch sein koennte:
 * ein Etikett, das immer dasselbe sagt, sieht im Log wie ein System aus, das
 * immer dasselbe tut.
 */

/** Eine Entscheidung mit frei waehlbarem Ausgang. */
function entscheidung(over: {
  kind: "WATCH" | "REJECT" | "ENTER";
  rejectionReasons?: readonly string[];
  finalScore?: number | null;
}): PipelineOutcome extends { decision: infer D } ? D : never {
  return {
    decisionId: "d-1",
    tokenId: "t-1",
    kind: over.kind,
    finalScore: over.finalScore ?? 70,
    ev: { kind: "UNKNOWN", reason: "INSUFFICIENT_SAMPLE", sampleSize: 0 },
    dataCompleteness: 0.74,
    reasons: [],
    risks: [],
    rejectionReasons: over.rejectionReasons ?? [],
    scoreEngineVersion: "1.1.0",
    strategyVersionId: "sv-1",
    decidedAt: new Date("2026-09-11T00:00:00Z"),
  } as never;
}

describe("Etikett einer Entscheidung", () => {
  it("nennt bei WATCH kein Ablehnungswort", () => {
    // WATCH ist ein „noch nicht", kein „nein". Es mit einem Ablehnungsgrund zu
    // versehen waere eine Haerte, die die Entscheidung gar nicht enthaelt —
    // und der Betreiber wuerde ein Problem suchen, wo keines ist.
    const result = {
      kind: "NO_ENTRY",
      decision: entscheidung({ kind: "WATCH" }),
      created: [],
      persisted: null,
    } as unknown as PipelineOutcome;

    expect(labelOf(result)).toBe("WATCH");
  });

  it("haengt bei REJECT den ersten Grund an", () => {
    const result = {
      kind: "NO_ENTRY",
      decision: entscheidung({ kind: "REJECT", rejectionReasons: ["LIQUIDITY_TOO_LOW"] }),
      created: [],
      persisted: null,
    } as unknown as PipelineOutcome;

    expect(labelOf(result)).toBe("REJECT_LIQUIDITY_TOO_LOW");
  });

  it("zaehlt einen Einstieg ohne Fill NICHT als Einstieg", () => {
    // Die schmeichelhafte Variante waere, beides `ENTERED` zu nennen. Im
    // Betrieb ist sie die gefaehrliche: sie meldet Positionen, die es nicht
    // gibt.
    const ohneFill = {
      kind: "ENTERED",
      decision: entscheidung({ kind: "ENTER" }),
      created: [],
      persisted: { decisionId: "d-1" },
      autoPosition: { kind: "NOT_FILLED", outcome: { kind: "REJECTED" } },
    } as unknown as PipelineOutcome;

    expect(labelOf(ohneFill)).toBe("ENTERED_NOT_FILLED");

    const mitFill = {
      kind: "ENTERED",
      decision: entscheidung({ kind: "ENTER" }),
      created: [],
      persisted: { decisionId: "d-1" },
      autoPosition: { kind: "OPENED", positionId: "p-1", outcome: { kind: "FILLED" } },
    } as unknown as PipelineOutcome;

    expect(labelOf(mitFill)).toBe("ENTERED");
  });

  it("traegt den Grund eines blockierten Laufs", () => {
    const result = {
      kind: "BLOCKED",
      reason: "NO_FEATURE_VECTOR",
      detail: "zu wenig Historie",
    } as unknown as PipelineOutcome;

    expect(labelOf(result)).toBe("BLOCKED_NO_FEATURE_VECTOR");
  });

  it("wiederholt den Quellengrund nicht", () => {
    // Er steht bereits je Token im Marktdaten-Lauf (`noSourceReasons`).
    // Dieselbe Auskunft zweimal zu fuehren heisst, sie zweimal pflegen zu
    // muessen — und irgendwann widersprechen sich die beiden Stellen.
    const result = {
      kind: "NO_SOURCE",
      reason: "QUOTE_RATE_LIMITED",
      attempted: ["jupiter-quote"],
    } as unknown as PipelineOutcome;

    expect(labelOf(result)).toBe("NO_SOURCE");
  });
});
