import eslint from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint flat config for all fits-js packages.
 *
 * Uses typescript-eslint v8+ with type-aware linting.  This catches real
 * bugs that plain TypeScript misses: floating promises, unsafe `any` usage,
 * and incorrect async patterns, all critical in a binary parser built on
 * async iteration and a streaming RandomAccessReader, where a dropped or
 * unawaited read is an easy and nasty bug.
 *
 * Prettier is integrated via eslint-plugin-prettier so formatting violations
 * surface as lint errors and get auto-fixed with `eslint --fix`.
 */
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "prettier/prettier": "error",
      // Allow unused vars prefixed with _ (common for destructuring discards)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Explicit any is sometimes unavoidable at the raw-buffer boundary
      "@typescript-eslint/no-explicit-any": "warn",
      // Require awaiting floating promises, critical for reader/stream safety
      "@typescript-eslint/no-floating-promises": "error",
      // Disallow .then() when async/await is available
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // node:test's describe/it/test return promises handled by the runner
    files: ["**/*.test.ts", "**/*.test.js"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
      "require-yield": "off",
    },
  },
  {
    ignores: ["dist/", "coverage/", "*.config.*"],
  },
);
