import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import saeRules from "./eslint-rules/no-numeric-fallback.js";

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
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-console": "off" },
  },
];
