import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import noNumericFallback from "./eslint-rules/no-numeric-fallback.js";
import noDateInSql from "./eslint-rules/no-date-in-sql.js";

/**
 * Ein einziges `sae`-Plugin.
 *
 * ESLint erlaubt es nicht, denselben Plugin-Namen in mehreren Config-Bloecken
 * zu definieren. Die hauseigenen Regeln werden deshalb hier zusammengefuehrt
 * und unten nur noch je Dateibereich unterschiedlich scharf gestellt.
 */
const saeRules = { rules: { ...noNumericFallback.rules, ...noDateInSql.rules } };

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/migrations/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint, sae: saeRules },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    /**
     * Handelsrelevanter Code: hier gilt zusaetzlich das Verbot numerischer
     * Ersatzwerte. Tests und Infrastruktur sind ausgenommen — dort sind feste
     * Zahlen genau das, was man will.
     */
    files: [
      "packages/core/src/**/*.ts",
      "packages/config/src/**/*.ts",
      "packages/simulation/src/**/*.ts",
      "packages/db/src/pit/**/*.ts",
      "apps/worker/src/**/*.ts",
      "apps/signer/src/**/*.ts",
    ],
    ignores: ["**/__tests__/**"],
    plugins: { sae: saeRules },
    rules: {
      "sae/no-numeric-fallback": "error",
    },
  },
  {
    /**
     * Datenbankcode: kein `Date` direkt in einem sql-Fragment.
     *
     * Gilt ausdruecklich AUCH fuer Tests. Die Regel schuetzt vor einem
     * Unterschied zwischen Testtreiber (PGlite) und Betriebstreiber
     * (postgres-js) — eine Ausnahme fuer Tests wuerde genau die Stelle
     * freistellen, an der der Unterschied unsichtbar bleibt.
     */
    files: ["packages/db/src/**/*.ts", "apps/**/*.ts"],
    rules: {
      "sae/no-date-in-sql": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-console": "off" },
  },
];
