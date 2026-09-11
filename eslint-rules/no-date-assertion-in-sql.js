/**
 * Verbietet die Behauptung `sql<Date>` ohne `string` daneben.
 *
 * Die Schwesterregel zu `no-date-in-sql`, fuer die andere Richtung. Jene
 * verhindert, dass ein `Date` in ein SQL-Fragment HINEIN gebunden wird; diese
 * verhindert, dass man sich beim HERAUSLESEN einen Typ zurechtlegt, den der
 * Treiber nicht liefert.
 *
 * Der Anlass ist ein echter Ausfall, kein theoretisches Risiko:
 *
 *   TypeError: a.lastSnapshotAt?.toISOString is not a function
 *
 * Dahinter stand `sql<Date | null>\`max(${tokenSnapshots.observedAt})\``. Das
 * spitze Klammerpaar ist eine **Behauptung ueber den Typ und keine
 * Umwandlung**. Bei einer normalen Spaltenauswahl stimmt sie, weil Drizzle den
 * Spaltentyp kennt. Bei einem rohen Ausdruck wie `max(...)` oder `min(...)`
 * kennt er ihn nicht, und was ankommt, haengt am Treiber: unter PGlite ein
 * `Date`, in der Produktion eine Zeichenkette.
 *
 * Dieselbe Asymmetrie wie bei der Schwesterregel — gruener Testlauf, Absturz
 * im Betrieb. Und `?.` half nicht: es faengt `null` und `undefined`, nicht
 * „ist da, aber ist eine Zeichenkette".
 *
 * Erlaubt ist deshalb genau die ehrliche Form:
 *
 *   sql<Date | string | null>`max(...)`   // und dann durch `asDate()`
 *
 * Weil `string` kein `toISOString` hat, zwingt der Compiler danach jeden
 * Aufrufer zur Umwandlung. Aus einem Laufzeitabsturz wird ein
 * Uebersetzungsfehler.
 */

/** Sammelt alle Bezeichnernamen eines Typausdrucks. */
function typeNames(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (node.type === "TSTypeReference" && node.typeName?.type === "Identifier") {
    out.push(node.typeName.name);
  }
  if (node.type === "TSStringKeyword") out.push("string");
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) typeNames(v, out);
    else if (value !== null && typeof value === "object" && "type" in value) typeNames(value, out);
  }
  return out;
}

export const noDateAssertionInSql = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Kein sql<Date> ohne string: bei rohen Ausdruecken liefert der Treiber eine Zeichenkette",
    },
    schema: [],
    messages: {
      forbidden:
        "`sql<... Date ...>` behauptet einen Typ, den der Treiber bei einem rohen Ausdruck " +
        "nicht garantiert: unter PGlite (Tests) kommt ein Date, in der Produktion eine " +
        "Zeichenkette — der Absturz erscheint also erst im laufenden System. Stattdessen " +
        "`sql<Date | string | null>` schreiben und das Ergebnis durch `asDate()` schicken.",
    },
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        const tag = node.tag;
        const isSqlTag =
          (tag.type === "Identifier" && tag.name === "sql") ||
          (tag.type === "MemberExpression" &&
            tag.object.type === "Identifier" &&
            tag.object.name === "sql");
        if (!isSqlTag) return;

        // Je nach Parser-Version heisst die Eigenschaft anders. Beide pruefen,
        // statt sich auf eine zu verlassen — eine Regel, die wegen eines
        // umbenannten Feldes still nichts mehr findet, ist schlimmer als keine.
        const args = node.typeArguments ?? node.typeParameters;
        if (args === undefined || args === null) return;

        const namen = typeNames(args);
        if (!namen.includes("Date")) return;
        // Die ehrliche Form ist erlaubt.
        if (namen.includes("string")) return;

        context.report({ node: args, messageId: "forbidden" });
      },
    };
  },
};

export default { rules: { "no-date-assertion-in-sql": noDateAssertionInSql } };
