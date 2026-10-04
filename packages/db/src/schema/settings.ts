import { bigint, boolean, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
    /**
     * Obergrenze der Marktkapitalisierung in USD.
     *
     * Stand vorher an DREI Stellen getrennt: als Literal `50000000` im SQL der
     * Suchraum-Auswahl, als `50_000_000` im Launch-Profil und als `5_000_000`
     * im Standard-Profil. Drei Zahlen fuer eine Frage, keine davon
     * einstellbar — und im Offensiv-Modus eine vierte, die den Deckel ganz
     * aufgemacht hat.
     */
    maxMarketCapUsd: bigint("max_market_cap_usd", { mode: "bigint" })
      .notNull()
      .default(5_000_000n),
    /**
     * Hoechstalter eines Coins in Minuten, gerechnet ab Entstehung des Pools.
     * `null` = keine Grenze.
     *
     * Gemessen an `tokens.launched_at`, und das ist die Entstehungszeit des
     * HANDELSPAARS aus der Anbieterantwort — nicht unser Erstkontakt. Fehlt
     * sie, ist das Alter unbekannt: bei gesetzter Grenze wird so ein Coin
     * ausgeschlossen, denn „ich weiss nicht, wie alt er ist" ist bei der
     * Vorgabe „nur neue" kein Durchlassgrund. Wie viele deswegen herausfallen,
     * steht im Log.
     */
    maxCoinAgeMinutes: integer("max_coin_age_minutes"),
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

/**
 * Die Wallets, deren Trades kopiert werden sollen.
 *
 * Eine eigene Tabelle und ausdruecklich keine Spalte in `paper_settings`: das
 * ist eine Liste, keine Einstellung. Sie waechst, sie schrumpft, und jeder
 * Eintrag traegt eigene Herkunft und eigenen Zeitpunkt — eine Liste in einem
 * JSON-Feld haette das alles verloren und waere nicht abfragbar.
 *
 * ### Warum `active` und nicht loeschen
 *
 * Eine Wallet, die einmal kopiert wurde, hat Positionen erzeugt. Loescht man
 * sie hart, zeigen diese Positionen auf nichts mehr, und die spaetere Frage
 * „von wem kam dieser Trade" ist nicht mehr beantwortbar. `active = false`
 * stoppt das Kopieren und behaelt die Zuordnung. Geloescht wird nur, was noch
 * nie etwas erzeugt hat — und das entscheidet die Abfrage, nicht der Knopf.
 */
export const copyWallets = pgTable(
  "copy_wallets",
  {
    /** Die Adresse selbst ist der Schluessel: dieselbe Wallet zweimal gibt es nicht. */
    address: text("address").primaryKey(),
    /**
     * Freier Name, damit die Liste lesbar bleibt.
     *
     * `null` heisst „ohne Namen" und nicht „leer": ein Pflichtfeld haette dazu
     * gefuehrt, dass beim Einfuegen von zwanzig Adressen zwanzig Platzhalter
     * entstehen, die niemand pflegt.
     */
    label: text("label"),
    /** Kopiert der Bot von dieser Wallet? Siehe Kommentar oben. */
    active: boolean("active").notNull().default(true),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    /** „dashboard" oder „umgebung" — dieselbe Unterscheidung wie in `paper_settings`. */
    addedBy: text("added_by").notNull(),
    /**
     * Bis zu welchem Zeitpunkt die Trades dieser Wallet schon gelesen wurden.
     *
     * Der Wasserstand des Kopierers. `null` heisst „noch nie gelesen" — und
     * dann wird ausdruecklich NICHT die ganze Historie kopiert, sondern ab
     * jetzt begonnen. Eine Wallet mit zwei Jahren Historie haette sonst beim
     * Hinzufuegen hunderte Positionen auf einmal erzeugt, alle mit Preisen von
     * damals. Das waere Look-Ahead in Reinform.
     */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /**
     * Die jüngste Signatur, die verarbeitet wurde.
     *
     * Der Zeitstempel allein genuegt nicht: mehrere Transaktionen teilen
     * denselben Slot, und ein Wiederanlauf wuerde sie doppelt kopieren. Die
     * Signatur ist eindeutig.
     */
    lastSignature: text("last_signature"),
    /** Wie viele Trades von dieser Wallet uebernommen wurden. Nur Anzeige. */
    copiedCount: integer("copied_count").notNull().default(0),
  },
  (t) => [
    // Base58 und Laenge in der DATENBANK, nicht nur im Formular. Eine Adresse
    // mit einem Tippfehler ist keine Adresse, und sie wuerde hier still als
    // „nie gehandelt" liegen, statt als Fehler aufzufallen.
    check("copy_wallets_address_shape", sql`char_length(${t.address}) between 32 and 44`),
    check("copy_wallets_label_length", sql`${t.label} is null or char_length(${t.label}) <= 60`),
    check("copy_wallets_copied_count", sql`${t.copiedCount} >= 0`),
  ],
);
