import { expectedFalsePositives, DEFAULT_ALPHA } from "./multiple-testing";
import type { FeaturePerformance, InteractionResult } from "./feature-analysis";
import type { ShadowComparison } from "./shadow";

/**
 * Forschungsbericht — und der No-Edge-Modus.
 *
 * §127 bis §129 und §148. Der Punkt, um den es geht, steht in den Leitplanken:
 * **„kein Vorteil gefunden" ist ein Ergebnis, kein Fehlschlag.** Ein System,
 * das nur Berichte ueber gefundene Zusammenhaenge kennt, erzeugt so lange
 * welche, bis es welche gibt.
 *
 * Deshalb hat dieser Bericht eine Zahl, die sonst fehlt: **wie viele Befunde
 * allein durch Zufall zu erwarten waren.** Fuenf bestaetigte Zusammenhaenge bei
 * 135 Versuchen und rund sieben erwarteten Scheinbefunden sind kein Ergebnis —
 * sie sind weniger, als der Zufall liefert. Ohne diese Gegenzahl liest sich
 * dieselbe Liste wie eine Entdeckung.
 *
 * Und: Befunde ohne belegte Trennung kommen gar nicht erst in die Liste. Ein
 * `NO_DIFFERENCE` ist kein schwacher Befund, sondern keiner.
 */

export interface ConfirmedFinding {
  readonly kind: "FEATURE" | "INTERACTION" | "SHADOW";
  readonly subject: string;
  readonly statement: string;
  readonly sampleSize: number;
  readonly comparisons: number;
}

export interface InconclusiveEntry {
  readonly subject: string;
  readonly reason: string;
}

export interface ResearchReport {
  readonly batchId: string;
  readonly generatedAt: Date;
  /** Nur Befunde mit belegter Trennung. */
  readonly confirmed: readonly ConfirmedFinding[];
  /** Geprueft, aber ohne belegten Unterschied. */
  readonly noDifference: readonly InconclusiveEntry[];
  /** Nicht beurteilbar — meist zu kleine Stichprobe. */
  readonly inconclusive: readonly InconclusiveEntry[];
  readonly hypothesesTested: number;
  /** Wie viele Befunde bei dieser Zahl von Versuchen zufaellig zu erwarten waeren. */
  readonly expectedByChance: number;
  /**
   * Bestaetigte Befunde geteilt durch die zufaellig erwarteten.
   *
   * Unter 1 heisst: weniger gefunden, als der Zufall liefert. Das ist die
   * ehrlichste Einzelzahl des ganzen Berichts.
   */
  readonly findingsVsChance: number | null;
  readonly verdict: "EDGE_FOUND" | "NO_EDGE" | "INCONCLUSIVE";
  readonly summary: string;
}

export interface ReportInputs {
  readonly batchId: string;
  readonly generatedAt: Date;
  readonly features: readonly FeaturePerformance[];
  readonly interactions: readonly InteractionResult[];
  readonly shadows: readonly ShadowComparison[];
  readonly alpha?: number;
}

export function buildResearchReport(input: ReportInputs): ResearchReport {
  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const confirmed: ConfirmedFinding[] = [];
  const noDifference: InconclusiveEntry[] = [];
  const inconclusive: InconclusiveEntry[] = [];

  for (const f of input.features) {
    const subject = `${f.feature} @ ${f.threshold}`;
    if (f.verdict === "SEPARATED") {
      confirmed.push({
        kind: "FEATURE",
        subject,
        statement:
          `${f.better === "ABOVE" ? "Ueber" : "Unter"} der Schwelle ` +
          `${((f.winRateGap ?? 0) * 100).toFixed(0)} Punkte hoehere Trefferquote.`,
        sampleSize: f.above.count + f.below.count,
        comparisons: f.comparisons,
      });
    } else if (f.verdict === "NO_DIFFERENCE") {
      noDifference.push({ subject, reason: f.note });
    } else {
      inconclusive.push({ subject, reason: f.note });
    }
  }

  for (const i of input.interactions) {
    const subject = `${i.featureA} × ${i.featureB}`;
    if (i.kind === "SYNERGY" || i.kind === "REDUNDANT") {
      confirmed.push({
        kind: "INTERACTION",
        subject,
        statement: i.note,
        sampleSize: Object.values(i.cells).reduce((sum, c) => sum + c.count, 0),
        comparisons: 1,
      });
    } else if (i.kind === "ADDITIVE") {
      noDifference.push({ subject, reason: i.note });
    } else {
      inconclusive.push({ subject, reason: i.note });
    }
  }

  for (const s of input.shadows) {
    const subject = `${s.challengerId} gegen ${s.championId}`;
    if (s.verdict === "CHALLENGER_BETTER" || s.verdict === "CHAMPION_BETTER") {
      confirmed.push({
        kind: "SHADOW",
        subject,
        statement: s.note,
        sampleSize: s.championOnly.resolvedCount + s.challengerOnly.resolvedCount,
        comparisons: 1,
      });
    } else if (s.verdict === "NO_DIFFERENCE") {
      noDifference.push({ subject, reason: s.note });
    } else {
      inconclusive.push({ subject, reason: s.note });
    }
  }

  const hypothesesTested =
    input.features.length + input.interactions.length + input.shadows.length;
  const expectedByChance = expectedFalsePositives(Math.max(1, hypothesesTested), alpha);
  const findingsVsChance =
    expectedByChance === 0 ? null : confirmed.length / expectedByChance;

  // Ein Bericht ohne bestaetigte Befunde ist kein leerer Bericht. Er sagt, dass
  // in diesen Daten kein Vorteil steckt — und das ist eine Aussage, die eine
  // Entscheidung traegt.
  const verdict: ResearchReport["verdict"] =
    confirmed.length === 0
      ? inconclusive.length > noDifference.length
        ? "INCONCLUSIVE"
        : "NO_EDGE"
      : (findingsVsChance ?? 0) <= 1
        ? "NO_EDGE"
        : "EDGE_FOUND";

  const summary =
    verdict === "EDGE_FOUND"
      ? `${confirmed.length} bestaetigte Befunde bei ${hypothesesTested} Versuchen; ` +
        `zufaellig zu erwarten waeren ${expectedByChance.toFixed(1)}.`
      : verdict === "NO_EDGE"
        ? confirmed.length === 0
          ? `Kein Vorteil gefunden. ${noDifference.length} Hypothesen geprueft und verworfen, ` +
            `${inconclusive.length} ohne ausreichende Daten. Das ist ein Ergebnis.`
          : `${confirmed.length} Befunde bei ${expectedByChance.toFixed(1)} zufaellig erwarteten — ` +
            "das ist nicht mehr, als der Zufall liefert."
        : `Kein Urteil moeglich: ${inconclusive.length} von ${hypothesesTested} Hypothesen ` +
          "hatten zu wenig Daten.";

  return {
    batchId: input.batchId,
    generatedAt: input.generatedAt,
    confirmed,
    noDifference,
    inconclusive,
    hypothesesTested,
    expectedByChance,
    findingsVsChance,
    verdict,
    summary,
  };
}

/* ---------------------------------------------------------------- §148 */

export interface NoEdgeSettings {
  /** Wie viele Berichte in Folge ohne Vorteil den Modus ausloesen. */
  readonly consecutiveReports: number;
}

export const DEFAULT_NO_EDGE_SETTINGS: NoEdgeSettings = { consecutiveReports: 3 };

export interface NoEdgeAssessment {
  readonly active: boolean;
  readonly consecutiveNoEdge: number;
  /**
   * Was der Modus bedeutet.
   *
   * Ausdruecklich NICHT „das System ist kaputt": die Paper-Stroeme laufen
   * weiter, die Datenerhebung laeuft weiter, und die naechste Marktphase kann
   * anders aussehen. Angehalten wird nur der Einsatz echten Geldes.
   */
  readonly recommendation: string;
}

/**
 * Bewertet die letzten Berichte.
 *
 * Der No-Edge-Modus ist kein Alarm, sondern eine Feststellung: in den zuletzt
 * untersuchten Daten war kein Vorteil nachweisbar. Solange das gilt, ist
 * „nicht handeln" die richtige Entscheidung — und die Leitplanken nennen NO
 * TRADE ausdruecklich ein erfolgreiches Ergebnis.
 */
export function assessNoEdge(
  reports: readonly ResearchReport[],
  settings: NoEdgeSettings = DEFAULT_NO_EDGE_SETTINGS,
): NoEdgeAssessment {
  // Neueste zuerst.
  const ordered = [...reports].sort(
    (a, b) => b.generatedAt.getTime() - a.generatedAt.getTime(),
  );

  let streak = 0;
  for (const report of ordered) {
    if (report.verdict === "EDGE_FOUND") break;
    streak += 1;
  }

  const active = streak >= settings.consecutiveReports;
  return {
    active,
    consecutiveNoEdge: streak,
    recommendation: active
      ? `${streak} Berichte in Folge ohne nachweisbaren Vorteil. Live-Handel bleibt aus; ` +
        "Auto Paper und Manual Paper laufen weiter, damit die naechste Marktphase " +
        "auf Daten trifft. Nicht handeln ist hier das Ergebnis, nicht das Scheitern."
      : `${streak} von ${settings.consecutiveReports} Berichten ohne Vorteil.`,
  };
}
