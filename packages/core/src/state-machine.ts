import { IllegalTransitionError } from "./errors";

/**
 * Typsichere Zustandsmaschine.
 *
 * Die Uebergangstabelle ist vollstaendig: der Compiler verlangt einen Eintrag fuer
 * JEDEN Zustand. Ein neu hinzugefuegter Zustand ohne definierte Uebergaenge ist damit
 * ein Typfehler und keine stille Luecke, durch die eine Position spaeter faellt.
 */
export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

export class StateMachine<S extends string> {
  readonly #table: TransitionTable<S>;
  readonly #name: string;

  constructor(name: string, table: TransitionTable<S>) {
    this.#name = name;
    this.#table = table;
  }

  canTransition(from: S, to: S): boolean {
    return this.#table[from].includes(to);
  }

  /** Wirft bei unzulaessigem Uebergang. Aufrufen, bevor Zustand persistiert wird. */
  assertTransition(from: S, to: S): void {
    if (!this.canTransition(from, to)) {
      throw new IllegalTransitionError(from, to, this.#name);
    }
  }

  nextStates(from: S): readonly S[] {
    return this.#table[from];
  }

  isTerminal(state: S): boolean {
    return this.#table[state].length === 0;
  }

  allStates(): S[] {
    return Object.keys(this.#table) as S[];
  }

  terminalStates(): S[] {
    return this.allStates().filter((s) => this.isTerminal(s));
  }
}
