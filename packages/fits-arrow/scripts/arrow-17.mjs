// Runs the suite against apache-arrow 17, the lowest version the peer range
// admits and the one duckdb-wasm depends on: `apache-arrow` resolves to the
// `apache-arrow-17` alias for everything the tests import.
import { register } from "node:module";

register("./arrow-17-hooks.mjs", import.meta.url);
