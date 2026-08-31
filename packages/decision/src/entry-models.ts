import { isPresent, type Maybe } from "@sae/core";
import type { FeatureVector } from "@sae/scoring";

/**
 * Vier Einstiegsmodelle als einzeln schaltbare Praedikate.
 *
 * Bisher gab es genau ein implizites Modell: „Score hoch genug, Gates
 * bestanden, kauf". Das laesst sich nicht auswerten. Wenn die Trefferquote
 * faellt, weiss niemand, ob das Fruehkaufen schlechter geworden ist oder das
 * Nachkaufen bestaetigter Bewegungen — es gibt keine zwei Zahlen zum
 * Vergleichen.
 *
 * §23 verlangt vier Modelle. Drei Regeln machen sie auswertbar:
 *
 * 1. **Einzeln abschaltbar**, damit im Backtest messbar wird, was jedes
 *    beitraegt.
 * 2. **Mehrfachtreffer bleiben mehrfach.** Passen zwei Modelle, werden beide
 *    festgehalten und nicht auf das erste reduziert — sonst haengt die
 *    Zuordnung an der Reihenfolge im Array, und die Statistik misst am Ende
 *    die Sortierung.
 * 3. **`NOT_COMPUTABLE` ist nicht `NO_MATCH`.** Ein Modell, das mangels Daten
 *    gar nicht bewertet werden konnte, darf nicht als „hat nicht ausgeloest"
 *    zaehlen. Sonst sieht ein Modell, dessen Daten oft fehlen, aus wie ein
 *    zurueckhaltendes — und seine Trefferquote wird an den wenigen Faellen
 *    gemessen, in denen zufaellig alles vorlag.
 *
 * Die Schwellen sind Startwerte und ausdruecklich nicht kalibriert.
 */

export type EntryModelId = "EARLY" | "CONFIRMATION" | "MOMENTUM" | "RETEST";

export type EntryModelResult =
  | { readonly kind: "MATCH"; readonly detail: string }
  | { readonly kind: "NO_MATCH"; readonly detail: string }
  | { readonly kind: "NOT_COMPUTABLE"; readonly missing: readonly string[] };

export interface EntryModelContext {
  readonly features: FeatureVector;
  /** Hoechstkurs seit Entdeckung, relativ zum aktuellen. Fuer RETEST noetig. */
  readonly pullbackFromHigh: Maybe<number>;
}

export interface EntryModel {
  readonly id: EntryModelId;
  readonly description: string;
  evaluate(ctx: EntryModelContext): EntryModelResult;
}

/** Sammelt fehlende Felder, damit `NOT_COMPUTABLE` benennbar ist. */
function require2<A, B>(
  a: readonly [string, Maybe<A>],
  b: readonly [string, Maybe<B>],
): { ok: true; a: A; b: B } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!isPresent(a[1])) missing.push(a[0]);
  if (!isPresent(b[1])) missing.push(b[0]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, a: (a[1] as { value: A }).value, b: (b[1] as { value: B }).value };
}

function require3<A, B, C>(
  a: readonly [string, Maybe<A>],
  b: readonly [string, Maybe<B>],
  c: readonly [string, Maybe<C>],
): { ok: true; a: A; b: B; c: C } | { ok: false; missing: string[] } {
  const first = require2(a, b);
  const missing: string[] = first.ok ? [] : first.missing;
  if (!isPresent(c[1])) missing.push(c[0]);
  if (missing.length > 0 || !first.ok) return { ok: false, missing };
  return { ok: true, a: first.a, b: first.b, c: (c[1] as { value: C }).value };
}

export interface EntryModelThresholds {
  /** EARLY: hoechstes Tokenalter in Sekunden. */
  readonly earlyMaxAgeSeconds: number;
  /** EARLY: Mindestzahl unterscheidbarer Akteure, damit es kein Einzelkaeufer ist. */
  readonly earlyMinDistinctActors: number;
  /** CONFIRMATION: Mindestalter, bevor eine Bewegung als bestaetigt gilt. */
  readonly confirmationMinAgeSeconds: number;
  readonly confirmationMinHolderGrowth: number;
  /** MOMENTUM: Mindestbeschleunigung des Volumens. */
  readonly momentumMinVolumeAcceleration: number;
  readonly momentumMinPriceChange5m: number;
  /** RETEST: Spanne des Rueckgangs vom Hoch, in der ein Wiedereinstieg zaehlt. */
  readonly retestMinPullback: number;
  readonly retestMaxPullback: number;
}

export const DEFAULT_ENTRY_MODEL_THRESHOLDS: EntryModelThresholds = {
  earlyMaxAgeSeconds: 900,
  earlyMinDistinctActors: 25,
  confirmationMinAgeSeconds: 1_800,
  confirmationMinHolderGrowth: 50,
  momentumMinVolumeAcceleration: 2,
  momentumMinPriceChange5m: 0.1,
  retestMinPullback: 0.2,
  retestMaxPullback: 0.5,
};

export function buildEntryModels(
  t: EntryModelThresholds = DEFAULT_ENTRY_MODEL_THRESHOLDS,
): readonly EntryModel[] {
  return [
    {
      id: "EARLY",
      description:
        "Sehr junger Token mit bereits verteilter Kaeuferbasis. Hoechste Chance, hoechstes Risiko.",
      evaluate({ features }) {
        const r = require2(
          ["market.tokenAgeSeconds", features.market.tokenAgeSeconds],
          ["holder.distinctActors", features.holder.distinctActors],
        );
        if (!r.ok) return { kind: "NOT_COMPUTABLE", missing: r.missing };
        if (r.a > t.earlyMaxAgeSeconds) {
          return { kind: "NO_MATCH", detail: `Token ${Math.round(r.a / 60)} min alt` };
        }
        // Ohne verteilte Kaeuferbasis ist „frueh" nur ein anderes Wort fuer
        // „vor allen anderen im Ausstieg eines Einzelnen".
        if (r.b < t.earlyMinDistinctActors) {
          return { kind: "NO_MATCH", detail: `nur ${r.b} unterscheidbare Akteure` };
        }
        return { kind: "MATCH", detail: `${Math.round(r.a / 60)} min alt, ${r.b} Akteure` };
      },
    },
    {
      id: "CONFIRMATION",
      description: "Bewegung haelt an und die Halterbasis waechst weiter. Spaeter, aber belegter.",
      evaluate({ features }) {
        const r = require3(
          ["market.tokenAgeSeconds", features.market.tokenAgeSeconds],
          ["holder.holderGrowth", features.holder.holderGrowth],
          ["momentum.priceChange1h", features.momentum.priceChange1h],
        );
        if (!r.ok) return { kind: "NOT_COMPUTABLE", missing: r.missing };
        if (r.a < t.confirmationMinAgeSeconds) {
          return { kind: "NO_MATCH", detail: "noch zu jung fuer eine Bestaetigung" };
        }
        if (r.b < t.confirmationMinHolderGrowth) {
          return { kind: "NO_MATCH", detail: `Halterwachstum ${r.b}` };
        }
        if (r.c <= 0) return { kind: "NO_MATCH", detail: "Stundenrendite nicht positiv" };
        return { kind: "MATCH", detail: `+${(r.c * 100).toFixed(0)} % in 1 h, ${r.b} neue Halter` };
      },
    },
    {
      id: "MOMENTUM",
      description: "Volumen beschleunigt und der Kurs zieht mit. Kuerzestes Zeitfenster.",
      evaluate({ features }) {
        const r = require2(
          ["momentum.volumeAcceleration", features.momentum.volumeAcceleration],
          ["momentum.priceChange5m", features.momentum.priceChange5m],
        );
        if (!r.ok) return { kind: "NOT_COMPUTABLE", missing: r.missing };
        if (r.a < t.momentumMinVolumeAcceleration) {
          return { kind: "NO_MATCH", detail: `Volumen bei Faktor ${r.a.toFixed(2)}` };
        }
        if (r.b < t.momentumMinPriceChange5m) {
          return { kind: "NO_MATCH", detail: `nur ${(r.b * 100).toFixed(1)} % in 5 min` };
        }
        return {
          kind: "MATCH",
          detail: `Volumen ×${r.a.toFixed(1)}, +${(r.b * 100).toFixed(0)} % in 5 min`,
        };
      },
    },
    {
      id: "RETEST",
      description:
        "Rueckgang vom Hoch in einer Spanne, die eine Korrektur und keinen Zusammenbruch beschreibt.",
      evaluate({ features, pullbackFromHigh }) {
        if (!isPresent(pullbackFromHigh)) {
          return { kind: "NOT_COMPUTABLE", missing: ["pullbackFromHigh"] };
        }
        if (!isPresent(features.momentum.volumeAcceleration)) {
          return { kind: "NOT_COMPUTABLE", missing: ["momentum.volumeAcceleration"] };
        }
        const pullback = pullbackFromHigh.value;
        if (pullback < t.retestMinPullback) {
          return { kind: "NO_MATCH", detail: "noch kein Rueckgang" };
        }
        // Nach oben begrenzt, weil ein tieferer Rueckgang keine Korrektur mehr
        // ist. Ohne diese Grenze waere „Retest" nur ein Name fuer fallendes
        // Messer fangen.
        if (pullback > t.retestMaxPullback) {
          return { kind: "NO_MATCH", detail: `${(pullback * 100).toFixed(0)} % unter Hoch` };
        }
        return { kind: "MATCH", detail: `${(pullback * 100).toFixed(0)} % unter Hoch` };
      },
    },
  ];
}

export interface EntryModelEvaluation {
  /** Modelle, die ausgeloest haben. Kann mehr als eines sein. */
  readonly matched: readonly EntryModelId[];
  readonly noMatch: readonly EntryModelId[];
  /** Modelle ohne Datengrundlage — ausdruecklich getrennt von `noMatch`. */
  readonly notComputable: readonly EntryModelId[];
  readonly disabled: readonly EntryModelId[];
  readonly details: Readonly<Partial<Record<EntryModelId, EntryModelResult>>>;
}

export function evaluateEntryModels(
  ctx: EntryModelContext,
  enabled: ReadonlySet<EntryModelId>,
  models: readonly EntryModel[] = buildEntryModels(),
): EntryModelEvaluation {
  const matched: EntryModelId[] = [];
  const noMatch: EntryModelId[] = [];
  const notComputable: EntryModelId[] = [];
  const disabled: EntryModelId[] = [];
  const details: Partial<Record<EntryModelId, EntryModelResult>> = {};

  for (const model of models) {
    if (!enabled.has(model.id)) {
      disabled.push(model.id);
      continue;
    }
    const result = model.evaluate(ctx);
    details[model.id] = result;
    if (result.kind === "MATCH") matched.push(model.id);
    else if (result.kind === "NO_MATCH") noMatch.push(model.id);
    else notComputable.push(model.id);
  }

  return { matched, noMatch, notComputable, disabled, details };
}

export const ALL_ENTRY_MODEL_IDS: readonly EntryModelId[] = [
  "EARLY",
  "CONFIRMATION",
  "MOMENTUM",
  "RETEST",
];
