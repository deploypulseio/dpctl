// ESLint 9 flat config (replaces .eslintrc.json).
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["script/**/*.ts"],
    plugins: { "@typescript-eslint": tsPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      // TS-aware version of no-unused-vars. Unused callback params and catch bindings are fine.
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      eqeqeq: "error",
      "no-eval": "error",
    },
  },
];
