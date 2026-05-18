import baseConfig from "@fits-js/eslint-config/base";

export default [
  ...baseConfig,
  {
    // Browser-safety guard: types: ["node"] hides these from tsc. Node is
    // reached only via dynamic import("node:..."), never a global or static
    // import. Full rationale in tooling/typescript/README.md.
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
];
