# @fits-js/integration-tests

Blocking `pnpm test:integration` step in CI, kept out of `pnpm blt` because it
needs Docker. `docker-compose.yml` brings up nginx over the committed
`packages/fits-core/test-fixtures/` on `localhost:18080` with native HTTP
`Range`. The test points `HttpRangeReader` at that URL and exercises
`openFits` + `readImage`.

```sh
pnpm fits:up && node --test $(find dist -name '*.test.js') && pnpm fits:down
```

A live public-archive smoke (MAST/ESO/IRSA) is not part of this suite. If
ever wanted, it belongs in its own non-blocking workflow so a third-party
outage cannot red the build.

## Adding a new test

1. Add (or reuse) a service in `docker-compose.yml` for the dependency.
2. Cross-check via an independent code path, not committed "expected"
   output. The oracle is the bytes themselves.
