import { and, desc, eq, isNull } from "drizzle-orm";

import type { Database } from "../client";
import { strategies, strategyVersions } from "../schema/strategy";

/**
 * Die Strategieversion, auf die sich Entscheidungen berufen.
 *
 * Ohne sie gibt es keine Entscheidung: `decisions` und `opportunities`
 * verweisen per Fremdschluessel darauf, und der Verweis ist Pflicht. Der Grund
 * steht im Schema — eine Parameteraenderung erzeugt IMMER eine neue Zeile,
 * damit jede zurueckliegende Trade-Statistik einem bekannten Parametersatz
 * zugeordnet bleibt.
 *
 * Angelegt wurde bisher **keine**. Die Tests legen sich eine an, der Betrieb
 * nie. Damit waere die erste echte Entscheidung an einem Fremdschluessel
 * gescheitert — und der Fehler haette nach einem Datenbankproblem ausgesehen,
 * nicht nach einer fehlenden Einrichtung.
 *
 * ### Was hier NICHT passiert
 *
 * Es wird nichts behauptet. Die Zeile haelt fest, mit welchen Parametern
 * gerechnet wird — sie sagt nicht, dass diese Parameter gut sind. `reason`
 * benennt das ausdruecklich, damit niemand die erste Version spaeter fuer ein
 * Ergebnis haelt.
 *
 * Idempotent: existiert eine aktive Version mit demselben Namen, wird sie
 * zurueckgegeben. Ein Neustart darf keine zweite anlegen, sonst zerfaellt die
 * Statistik in Versionen, die sich in nichts unterscheiden.
 */

export const BOOTSTRAP_STRATEGY_NAME = "default";
export const BOOTSTRAP_VERSION = "0.1.0";

export interface ActiveStrategyVersion {
  readonly id: string;
  readonly version: string;
  /** Ob dieser Aufruf sie angelegt hat. Nur fuer die Aufzeichnung. */
  readonly created: boolean;
}

export async function ensureActiveStrategyVersion(input: {
  readonly db: Database;
  readonly parameters: unknown;
  readonly at: Date;
}): Promise<ActiveStrategyVersion> {
  const [existingStrategy] = await input.db
    .select({ id: strategies.id })
    .from(strategies)
    .where(eq(strategies.name, BOOTSTRAP_STRATEGY_NAME))
    .limit(1);

  const strategyId =
    existingStrategy?.id ??
    (
      await input.db
        .insert(strategies)
        .values({ name: BOOTSTRAP_STRATEGY_NAME })
        .onConflictDoNothing({ target: strategies.name })
        .returning({ id: strategies.id })
    )[0]?.id ??
    // Zwischen Pruefung und Einfuegen kann ein zweiter Prozess zuvorgekommen
    // sein. Dann steht die Zeile jetzt da, und wir lesen sie.
    (
      await input.db
        .select({ id: strategies.id })
        .from(strategies)
        .where(eq(strategies.name, BOOTSTRAP_STRATEGY_NAME))
        .limit(1)
    )[0]?.id;

  if (strategyId === undefined) {
    throw new Error("Strategie konnte weder gelesen noch angelegt werden.");
  }

  const [active] = await input.db
    .select({ id: strategyVersions.id, version: strategyVersions.version })
    .from(strategyVersions)
    .where(and(eq(strategyVersions.strategyId, strategyId), isNull(strategyVersions.retiredAt)))
    .orderBy(desc(strategyVersions.createdAt))
    .limit(1);

  if (active !== undefined) {
    return { id: active.id, version: active.version, created: false };
  }

  const inserted = await input.db
    .insert(strategyVersions)
    .values({
      strategyId,
      version: BOOTSTRAP_VERSION,
      parameters: input.parameters as Record<string, unknown>,
      reason:
        "Startparameter. Ausdruecklich nicht validiert und nicht als profitabel " +
        "behauptet — sie halten fest, womit gerechnet wird.",
      activatedAt: input.at,
    })
    .onConflictDoNothing({ target: [strategyVersions.strategyId, strategyVersions.version] })
    .returning({ id: strategyVersions.id, version: strategyVersions.version });

  const row = inserted[0];
  if (row !== undefined) return { id: row.id, version: row.version, created: true };

  // Wettlauf verloren: die Version steht jetzt, angelegt von jemand anderem.
  const [race] = await input.db
    .select({ id: strategyVersions.id, version: strategyVersions.version })
    .from(strategyVersions)
    .where(
      and(
        eq(strategyVersions.strategyId, strategyId),
        eq(strategyVersions.version, BOOTSTRAP_VERSION),
      ),
    )
    .limit(1);
  if (race === undefined) throw new Error("Strategieversion konnte nicht ermittelt werden.");
  return { id: race.id, version: race.version, created: false };
}
