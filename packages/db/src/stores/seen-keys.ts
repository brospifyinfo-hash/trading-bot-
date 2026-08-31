import { eq } from "drizzle-orm";
import type { SeenKeys } from "@sae/pipeline";

import type { Database } from "../client";
import { tokenSnapshots } from "../schema/tokens";

/**
 * „Schon gesehen?" ohne zweite Wahrheit.
 *
 * Es gibt bewusst keine eigene Tabelle fuer gesehene Schluessel. Der Snapshot
 * selbst IST der Nachweis, dass ein Datenpunkt aufgenommen wurde — eine zweite
 * Tabelle daneben koennte auseinanderlaufen, und dann gaebe es zwei Antworten
 * auf dieselbe Frage.
 *
 * `add` ist deshalb absichtlich eine Leeroperation: geschrieben wird der
 * Schluessel dort, wo auch der Snapshot geschrieben wird, in derselben
 * Transaktion. Die eigentliche Absicherung ist ohnehin nicht diese Abfrage,
 * sondern `UNIQUE (ingest_key)` — die Abfrage spart nur eine vergebliche
 * Einfuegung.
 */
export class PostgresSeenKeys implements SeenKeys {
  constructor(private readonly db: Database) {}

  async has(key: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: tokenSnapshots.id })
      .from(tokenSnapshots)
      .where(eq(tokenSnapshots.ingestKey, key))
      .limit(1);
    return row !== undefined;
  }

  async add(_key: string): Promise<void> {
    // Siehe oben: der Schluessel entsteht mit dem Snapshot, nicht daneben.
  }
}
