// ESLint 9 reads only this flat config; it replaces .eslintrc.json, which it ignores.
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
      // The core rule does not understand TypeScript: it flags enum members and interface fields.
      // Unused callback parameters (reject, notify, argv) and catch bindings are this codebase's style.
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      eqeqeq: "error",
      "no-eval": "error",
    },
  },
];
