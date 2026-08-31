import type { Clock } from "@sae/core";

/**
 * Wiederaufnahme nach einem Absturz.
 *
 * Ein Job, der 400 Tokens verarbeitet und beim 380. stirbt, darf beim Neustart
 * nicht wieder bei null anfangen — nicht wegen der Rechenzeit, sondern wegen
 * der API-Aufrufe: 380 unnoetige Anfragen sind Rate-Limit-Budget, das im
 * naechsten Durchlauf fehlt.
 *
 * Der Checkpoint haelt deshalb fest, was bereits erledigt ist. Er ist bewusst
 * eine LISTE erledigter Einheiten und kein Zaehler: bei einem Zaehler haengt die
 * Wiederaufnahme daran, dass die Reihenfolge beim zweiten Lauf dieselbe ist —
 * und das ist bei einer Discovery-Liste nie garantiert.
 */

export interface CheckpointState {
  readonly jobKey: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly doneUnits: readonly string[];
  readonly totalUnits: number | null;
}

export interface CheckpointStore {
  load(jobKey: string): Promise<CheckpointState | null>;
  save(state: CheckpointState): Promise<void>;
  clear(jobKey: string): Promise<void>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  readonly #states = new Map<string, CheckpointState>();

  async load(jobKey: string): Promise<CheckpointState | null> {
    return this.#states.get(jobKey) ?? null;
  }

  async save(state: CheckpointState): Promise<void> {
    this.#states.set(state.jobKey, state);
  }

  async clear(jobKey: string): Promise<void> {
    this.#states.delete(jobKey);
  }
}

export interface ResumableRunResult<R> {
  readonly processed: number;
  readonly skipped: number;
  readonly results: readonly R[];
  readonly completed: boolean;
}

/**
 * Arbeitet eine Liste von Einheiten ab und merkt sich den Fortschritt.
 *
 * `maxUnitsPerRun` deckelt, wie viel ein einzelner Lauf tut. Ohne diesen Deckel
 * kann ein Job mit einer sehr langen Liste beliebig lange laufen und dabei
 * beliebig viele Anfragen erzeugen — genau das, was bei einem Anbieter mit
 * Rate Limit nicht passieren darf.
 */
export async function runResumable<U, R>(input: {
  readonly jobKey: string;
  readonly units: readonly U[];
  readonly unitId: (unit: U) => string;
  readonly process: (unit: U) => Promise<R>;
  readonly store: CheckpointStore;
  readonly clock: Clock;
  readonly maxUnitsPerRun: number;
}): Promise<ResumableRunResult<R>> {
  if (input.maxUnitsPerRun < 1) {
    throw new RangeError("maxUnitsPerRun muss mindestens 1 sein");
  }

  const existing = await input.store.load(input.jobKey);
  const done = new Set(existing?.doneUnits ?? []);
  const startedAt = existing?.startedAt ?? input.clock.now();

  const results: R[] = [];
  let processed = 0;
  let skipped = 0;

  for (const unit of input.units) {
    const id = input.unitId(unit);
    if (done.has(id)) {
      skipped += 1;
      continue;
    }
    if (processed >= input.maxUnitsPerRun) break;

    results.push(await input.process(unit));
    done.add(id);
    processed += 1;

    await input.store.save({
      jobKey: input.jobKey,
      startedAt,
      updatedAt: input.clock.now(),
      doneUnits: [...done],
      totalUnits: input.units.length,
    });
  }

  const completed = input.units.every((u) => done.has(input.unitId(u)));
  if (completed) await input.store.clear(input.jobKey);

  return { processed, skipped, results, completed };
}
