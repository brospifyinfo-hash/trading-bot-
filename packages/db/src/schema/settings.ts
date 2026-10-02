import { bigint, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Was der Betreiber eingestellt hat — in der Datenbank, nicht in der Umgebung.
 *
 * Der Grund fuer den Umzug ist nicht Bequemlichkeit. Dashboard und Worker
 * laufen auf verschiedenen Maschinen (Vercel und Railway). Eine Einstellung in
 * der Umgebung kann die Oberflaeche nicht schreiben und auch nicht ehrlich
 * anzeigen: sie saehe ihre eigene Umgebung und nicht die des Workers. Die
 * Datenbank ist die einzige Stelle, die beide gemeinsam haben.
 *
 * ### Genau eine Zeile
 *
 * `id` ist ein `boolean` mit `CHECK (id)` und Primaerschluessel. Damit laesst
 * die Datenbank selbst keine zweite Zeile zu. Das ist strenger als ein
 * `LIMIT 1` im Code: eine zweite Zeile waere sonst irgendwann da, und welche
 * von beiden gilt, entschiede die Sortierung — also der Zufall.
 *
 * ### Was NICHT hier steht
 *
 * Risikogrenzen, Sicherheitstore, Positionsgroessen. Die sind Teil der
 * unveraenderlichen Strategie-Version und gehoeren nicht in eine Tabelle, die
 * sich jederzeit aendern laesst. Einstellbar ist genau die Zahl, die der
 * Betreiber einstellen koennen soll.
 */
export const paperSettings = pgTable(
  "paper_settings",
  {
    /** Immer `true`. Der Primaerschluessel, der die Tabelle einzeilig haelt. */
    id: text("id").primaryKey().default("singleton"),
    /** Einstiegsschwelle, 10 bis 95. Die Grenzen stehen auch in der Datenbank. */
    entryScore: integer("entry_score").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Wer zuletzt geaendert hat.
     *
     * Frei waehlbarer Text und bewusst kein Fremdschluessel auf `users`: es
     * gibt genau einen Betreiber, und die Herkunft, die hier interessiert, ist
     * „aus dem Dashboard" gegen „beim ersten Start aus der Umgebung
     * uebernommen". Ein Nutzerbezug waere eine Genauigkeit, die es nicht gibt.
     */
    updatedBy: text("updated_by").notNull(),
    /**
     * Wie waehlerisch der Bot ist.
     *
     * `VORSICHTIG` entscheidet nur mit vollstaendigen Pflichtdaten,
     * `OFFENSIV` mit dem, was bekannt ist. Beides ausschliesslich Papier; die
     * Erzwingung liegt in der Pipeline, weil eine Tabelle den
     * Ausfuehrungsmodus nicht sehen kann.
     */
    mode: text("mode", { enum: ["VORSICHTIG", "OFFENSIV"] })
      .notNull()
      .default("VORSICHTIG"),
    /**
     * Gewuenschter Einsatz je Trade, in der kleinsten Einheit (Cent).
     *
     * `null` heisst: keine Vorgabe, es gilt das Risikobudget der
     * Strategieversion. Ausdruecklich KEINE 0 dafuer — 0 waere ein Einsatz von
     * null und damit ein Trade, den es nicht gibt.
     *
     * `bigint`, weil Geld in diesem System nie als Gleitkommazahl gefuehrt
     * wird. Die Obergrenzen des Kontos gelten weiter: wer mehr einstellt, als
     * die Portfolio-Grenze hergibt, bekommt die Grenze — und das Dashboard
     * sagt, welche gebunden hat.
     */
    entryNotionalMinor: bigint("entry_notional_minor", { mode: "bigint" }),
  },
  (t) => [
    check("paper_settings_singleton", sql`${t.id} = 'singleton'`),
    check("paper_settings_entry_score", sql`${t.entryScore} BETWEEN 10 AND 95`),
    // Null ist erlaubt (keine Vorgabe), 0 oder negativ nicht.
    check(
      "paper_settings_entry_notional",
      sql`${t.entryNotionalMinor} IS NULL OR ${t.entryNotionalMinor} > 0`,
    ),
  ],
);
