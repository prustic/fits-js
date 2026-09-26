import baseConfig from "@fits-js/eslint-config/base";

export default [
  ...baseConfig,
  {
    // Browser-safety guard, as in @fits-js/core: types: ["node"] hides these
    // from tsc. Full rationale in tooling/typescript/README.md.
    rules: {
      "no-restricted-globals": [
        "error",
        "Buffer",
        "process",
        "global",
        "__dirname",
        "__filename",
        "setImmediate",
        "clearImmediate",
      ],
      "no-restricted-imports": ["error", { patterns: ["node:*", "node:*/*"] }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Node-only test harness, outside the typed project and never published.
    ignores: ["scripts/"],
  },
];
