import type { ProviderId } from "@sae/core";
import type { Provider, ProviderKind } from "./types";

/**
 * Provider-Verzeichnis.
 *
 * Je Kategorie eine geordnete Liste: der erste gesunde Anbieter gewinnt. Die
 * Reihenfolge ist Konfiguration, nicht Code — ein Anbieterwechsel darf keine
 * Codeaenderung sein.
 *
 * Wichtig fuer die Hard Gates: `criticalKinds` benennt die Kategorien, ohne die
 * nicht eingestiegen werden darf. Marktdaten und Router gehoeren dazu, Social
 * nicht — fehlendes Social senkt die Datenvollstaendigkeit, fehlende Preise
 * machen jede Entscheidung wertlos.
 */
export class ProviderRegistry {
  readonly #byKind = new Map<ProviderKind, Provider[]>();

  register(provider: Provider): void {
    const list = this.#byKind.get(provider.descriptor.kind) ?? [];
    list.push(provider);
    this.#byKind.set(provider.descriptor.kind, list);
  }

  /** Erster Anbieter der Kategorie, der nicht DOWN ist. */
  primary<T extends Provider>(kind: ProviderKind): T | null {
    const list = this.#byKind.get(kind) ?? [];
    const usable = list.find((p) => p.health().status !== "DOWN");
    return (usable as T | undefined) ?? null;
  }

  all(kind: ProviderKind): readonly Provider[] {
    return this.#byKind.get(kind) ?? [];
  }

  get(id: ProviderId): Provider | null {
    for (const list of this.#byKind.values()) {
      const found = list.find((p) => p.descriptor.id === id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Kategorien ohne verfuegbaren Anbieter.
   * Ist eine kritische Kategorie dabei, blockiert das den Einstieg.
   */
  unavailableKinds(required: readonly ProviderKind[]): ProviderKind[] {
    return required.filter((kind) => this.primary(kind) === null);
  }

  snapshot(): Array<{ id: ProviderId; kind: ProviderKind; status: string; detail: string | null }> {
    const out: Array<{ id: ProviderId; kind: ProviderKind; status: string; detail: string | null }> =
      [];
    for (const [kind, list] of this.#byKind) {
      for (const p of list) {
        const h = p.health();
        out.push({ id: p.descriptor.id, kind, status: h.status, detail: h.detail });
      }
    }
    return out;
  }
}

/** Ohne diese Kategorien wird nicht eingestiegen. */
export const CRITICAL_PROVIDER_KINDS: readonly ProviderKind[] = ["market", "router"];
