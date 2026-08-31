import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Wacht darueber, dass die benannten Invarianten nicht verschwinden.
 *
 * Ein Test kann auf zwei Arten aufhoeren zu schuetzen: er faellt weg, oder er
 * wird beim Umbenennen so unkenntlich, dass niemand mehr merkt, welche Zusage
 * er absichert. Beides faellt hier auf.
 *
 * Der Test prueft NICHT, ob die Invarianten stimmen — das tun die Tests selbst.
 * Er prueft, dass es sie gibt. Das ist ein Buchhaltungstest, und als solcher
 * bewusst duenn.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

/** Die Zusagen, die dieses System ueber sich selbst macht. */
const REQUIRED = [
  "MISSED_IS_NOT_LOSS",
  "USER_REJECTED_IS_NOT_LOSS",
  "PAPER_IS_NOT_LIVE",
  "HISTORICAL_PERFORMANCE_IS_NOT_GUARANTEED",
  "NO_FUTURE_DATA_IN_HISTORICAL_DECISION",
  "LIVE_DATA_FAILURE_CANNOT_CREATE_VALID_SIGNAL",
  "DUPLICATE_EVENT_CANNOT_CREATE_DUPLICATE_TRADE",
  "DUPLICATE_JOB_IS_IDEMPOTENT",
] as const;

const SKIP = new Set(["node_modules", "dist", ".next", ".git", "coverage"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = testFiles(join(repoRoot, "packages")).concat(testFiles(join(repoRoot, "apps")));

/** Wo eine Invariante genannt wird — ohne diese Datei selbst. */
function locations(name: string): string[] {
  return files
    .filter((f) => f !== join(here, "named-invariants.test.ts"))
    .filter((f) => readFileSync(f, "utf8").includes(name))
    .map((f) => relative(repoRoot, f));
}

describe("Benannte Invarianten sind vorhanden", () => {
  for (const name of REQUIRED) {
    it(`${name} wird von mindestens einem Test getragen`, () => {
      const found = locations(name);
      expect(found, `Kein Test nennt ${name}`).not.toHaveLength(0);
    });
  }

  it("findet ueberhaupt Testdateien", () => {
    // Schutz gegen den stillen Fehlschlag: waere die Suche kaputt, meldeten
    // alle Pruefungen oben faelschlich Erfolg auf einer leeren Liste.
    expect(files.length).toBeGreaterThan(20);
  });
});
