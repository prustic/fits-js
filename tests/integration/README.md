# @fits-js/integration-tests

End-to-end integration tests, run as the blocking `pnpm test:integration`
step in CI. They are kept out of `pnpm blt` because they exercise real
OS-level transports (sockets, real `node:http`, real `node:fs`) and so are
slower and noisier than the deterministic unit suite, but still
self-contained and reproducible.

The current test serves a committed real-archive fixture
(`packages/fits-core/test-fixtures/fos-mef.fits`) from a small in-process
`node:http` server, then exercises `HttpRangeReader` → `openFits` →
`readImage` over it. Real HTTP, real `Range`, real archive bytes, fully
under our control. A live public archive smoke against MAST/ESO/IRSA is not
part of the PR-blocking CI path; if ever wanted, it belongs in its own
non-blocking workflow (`workflow_dispatch` or scheduled), so a third-party
outage cannot red the build (the same pattern `astropy` uses with
`@pytest.mark.remote_data`).

## Adding a new test

1. Spin up the lightest real dependency the path under test needs (a local
   `node:http` server over a committed fixture, a temp file, a local
   process). Do not depend on a third-party host in the PR-blocking suite.
2. Cross-check via an independent code path, not committed "expected"
   output; the oracle is the bytes themselves.
3. Tear down in `t.after`.
