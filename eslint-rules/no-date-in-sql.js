/**
 * Verbietet einen `Date`-Wert direkt in einem `sql`-Fragment.
 *
 * Der Hintergrund ist ein echter Ausfall, kein theoretisches Risiko: Tests
 * laufen gegen PGlite, der Betrieb gegen `postgres-js`. PGlite akzeptiert ein
 * gebundenes `Date` klaglos; `postgres-js` bricht ab mit
 *
 *   The "string" argument must be of type string or an instance of Buffer
 *   or ArrayBuffer. Received an instance of Date
 *
 * Ein Fehler dieser Art ueberlebt also jeden gruenen Testlauf und schlaegt
 * erst im laufenden System zu. Betroffen waren unter anderem
 * `reclaimExpired` (Auftraege abgestuerzter Worker), `expireOverdue`
 * (Ablauf von Gelegenheiten) und `loadDiagnostics` (der Endpunkt, der sagen
 * soll, ob ueberhaupt etwas laeuft) — alles Stellen, deren Ausfall man erst
 * daran merkt, dass etwas anderes fehlt.
 *
 * Richtig ist die ISO-Zeichenkette mit ausdruecklichem Cast:
 *
 *   sql`${col} >= ${since.toISOString()}::timestamptz`
 *
 * Der Cast ist nicht optional: ohne ihn leitet Postgres den Typ aus dem
 * ungetypten Parameter ab und bekommt `text`.
 *
 * Die Regel ist syntaktisch und damit im Zweifel zu streng — sie sieht keine
 * Typen, nur Namen und Ausdruecke. Das ist die richtige Richtung: ein
 * Fehlalarm kostet eine Zeile Begruendung, ein uebersehener Fall einen
 * Produktionsausfall, den kein Test zeigt.
 */

/** Bezeichner, die erfahrungsgemaess einen Zeitpunkt tragen. */
const TIME_NAME = /(^|[a-z])(now|at|since|as_?of|until|time|stamp|date|before|after|deadline|expiry|expires)([A-Z_]|$)/i;

/** Ausdruecke, die sicher schon eine Zeichenkette sind. */
function isAlreadySafe(node) {
  // `x.toISOString()` — der vorgesehene Weg.
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "toISOString"
  ) {
    return true;
  }
  // Zeichenketten-Literale und Template-Strings.
  if (node.type === "Literal" && typeof node.value === "string") return true;
  if (node.type === "TemplateLiteral") return true;
  // `String(x)` und `x.toString()`.
  if (node.type === "CallExpression") {
    if (node.callee.type === "Identifier" && node.callee.name === "String") return true;
    if (
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "toString"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Der Name, unter dem ein Ausdruck im Code steht — fuer die Namensheuristik.
 *
 * Eine Spaltenreferenz (`table.column`) ist ein Bezeichner und kein Wert; sie
 * wird von Drizzle zu SQL und nie zu einem Parameter. Solche Ausdruecke
 * duerfen die Regel nicht ausloesen, sonst waere jede Zeitspalte ein Treffer.
 */
function bindingName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Date") {
    return "Date";
  }
  return null;
}

export const noDateInSql = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Kein Date-Wert direkt in einem sql-Fragment: postgres-js bricht ab, PGlite nicht",
    },
    schema: [],
    messages: {
      forbidden:
        "`{{name}}` sieht nach einem Zeitpunkt aus und wird direkt in ein sql-Fragment gebunden. " +
        "Unter postgres-js (Betrieb) bricht das ab, unter PGlite (Tests) nicht — der Fehler " +
        "erscheint also erst im laufenden System. Stattdessen: " +
        "${{{name}}.toISOString()}::timestamptz",
    },
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        // Nur `sql`...`` und `sql.raw`...``-artige Tags.
        const tag = node.tag;
        const isSqlTag =
          (tag.type === "Identifier" && tag.name === "sql") ||
          (tag.type === "MemberExpression" &&
            tag.object.type === "Identifier" &&
            tag.object.name === "sql");
        if (!isSqlTag) return;

        for (const expr of node.quasi.expressions) {
          if (isAlreadySafe(expr)) continue;
          const name = bindingName(expr);
          if (name === null) continue;
          if (!TIME_NAME.test(name)) continue;
          context.report({ node: expr, messageId: "forbidden", data: { name } });
        }
      },
    };
  },
};

export default { rules: { "no-date-in-sql": noDateInSql } };
