# @fits-js/typescript-config

Shared TypeScript base every package extends. `base.json` carries no comments
on purpose: an editor flags comments in any JSON file not named `tsconfig.json`
(error 521), and the tooling sees this as plain `.json`. The rationale lives
here instead.

- **`target` / `lib`: ES2023.** Node 22's V8 runs every ES2023 feature
  natively. Downleveling would rewrite class fields, drop `Error.cause`,
  polyfill `Array.at`, and forbid top-level await for no gain.
- **`module` / `moduleResolution`: NodeNext.** Tracks Node's current ESM
  behavior; requires explicit `.js` import extensions.
- **`strict`: true.** FITS arrives as raw bytes; the boundary between the
  wire format and the parsed model must be airtight, and the core stays free
  of runtime dependencies.
- **`types: ["node"]`.** `@fits-js/core` needs the `Blob` / `fetch` / `URL` /
  `AbortSignal` ambients, which are absent from the ES2023 lib (no DOM lib is
  pulled in, to stay runtime-neutral). `@types/node` supplies them. The side
  effect is that Node-only globals (`Buffer`, `process`, …) and `node:*`
  imports also type-check silently, so core's browser-safety guarantee is
  enforced by ESLint, not `tsc`: `no-restricted-globals` for the globals and
  `no-restricted-imports` for static `node:*` (in
  `packages/fits-core/eslint.config.js`, relaxed for `*.test.ts`). Platform
  code reaches Node only through dynamic `import("node:...")`, which neither
  rule restricts.
