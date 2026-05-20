# @fits-js/integration-tests

End-to-end integration tests, run as the blocking `pnpm test:integration`
step in CI. They are kept out of `pnpm blt` because they need Docker to
orchestrate a real HTTP server, but the result is fully self-contained and
reproducible.

The current shape: `docker-compose.yml` brings up `nginx:alpine` mounted on
the committed real-archive fixtures in `packages/fits-core/test-fixtures/`,
exposing them on `localhost:18080` with native HTTP `Range` support. The
test points `HttpRangeReader` at that URL and exercises `openFits` +
`readImage`. `pnpm test:integration` orchestrates the lifecycle:

```sh
pnpm fits:up && node --test $(find dist -name '*.test.js') && pnpm fits:down
```

A live public archive smoke (MAST/ESO/IRSA) is not part of this suite; if
ever wanted, it belongs in its own non-blocking workflow
(`workflow_dispatch` or scheduled), so a third-party outage cannot red the
build.

## Adding a new test

1. Add (or reuse) a service in `docker-compose.yml` for the dependency.
2. Cross-check via an independent code path, not committed "expected"
   output; the oracle is the bytes themselves.
3. The shared `pnpm fits:up`/`fits:down` lifecycle starts and tears down
   the compose stack around the run.
