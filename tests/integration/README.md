# @fits-js/integration-tests

Real-archive integration tests against live public FITS endpoints, run as the
blocking `pnpm test:integration` step in CI. They are not part of `pnpm blt`
because they need the network and target a third-party host; an outage skips
the affected test rather than reding the build.

Tests live alongside `src/*.test.ts` and are run by `node --test` against the
compiled `dist/`. Each pins a specific public URL and asserts via independent
in-test decode (a different code path than the production decoder), so the
oracle is the bytes themselves, never astropy or any other reference output.

## Adding a new test

1. Pin a stable, publicly Range-supporting URL (a static archive product, not
   a CGI cutout endpoint that may go away).
2. Skip cleanly on network failure (`fetch HEAD`, `t.skip(...)` on rejection).
3. Cross-check via an independent code path, not by asserting committed
   "expected" output; this is the differential-testing rule.
