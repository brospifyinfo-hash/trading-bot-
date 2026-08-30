/**
 * Verbietet numerische Ersatzwerte in handelsrelevantem Code.
 *
 * Der Ausdruck `liquidity ?? 0` oder `score || 50` ist die bequemste Art, aus
 * einer fehlenden Beobachtung eine Zahl zu machen. Genau das darf in diesem
 * System nicht passieren: fehlende Daten senken die Datenvollstaendigkeit und
 * koennen ein Hard Gate ausloesen — sie werden nie stillschweigend ersetzt.
 *
 * Die Regel ist bewusst syntaktisch und nicht typbasiert: sie greift damit auch
 * dort, wo noch kein `Maybe<T>` verwendet wird, und ist im Zweifel zu streng.
 * Ein begruendeter Einzelfall wird mit einer eslint-disable-Zeile samt
 * Begruendung ausgenommen — sichtbar im Diff, statt unsichtbar im Ausdruck.
 */
export const noNumericFallback = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Kein numerischer Ersatzwert fuer fehlende Daten in handelsrelevantem Code",
    },
    schema: [],
    messages: {
      forbidden:
        "Numerischer Ersatzwert ({{operator}} {{value}}) fuer moeglicherweise fehlende Daten. " +
        "Fehlende Werte muessen als MISSING behandelt werden, nicht durch eine Zahl ersetzt.",
    },
  },
  create(context) {
    const check = (node) => {
      if (node.operator !== "??" && node.operator !== "||") return;
      const right = node.right;

      const isNumericLiteral = right.type === "Literal" && typeof right.value === "number";
      const isNegativeNumber =
        right.type === "UnaryExpression" &&
        right.operator === "-" &&
        right.argument.type === "Literal" &&
        typeof right.argument.value === "number";

      if (!isNumericLiteral && !isNegativeNumber) return;

      context.report({
        node,
        messageId: "forbidden",
        data: {
          operator: node.operator,
          value: isNumericLiteral ? String(right.value) : `-${String(right.argument.value)}`,
        },
      });
    };

    return { LogicalExpression: check };
  },
};

export default { rules: { "no-numeric-fallback": noNumericFallback } };
