# Contributing to fits-js

Thanks for considering a contribution. fits-js is a TypeScript implementation of the FITS file format for JavaScript runtimes. PRs that improve spec fidelity, fix bugs, fill in capability gaps, or sharpen the docs are all welcome.

The project is in its planning phase: the repository currently holds tooling and scaffolding, not an implementation. Issues that discuss scope, real-world FITS files that break assumptions, and use cases are useful right now even before there is code to patch.

## Ways to contribute

- Report bugs by opening an issue with a reproduction and, where possible, the FITS file (or a minimal slice of it) that triggers the problem.
- Suggest features by opening an issue with the use case and, where relevant, how CFITSIO or astropy handles the same thing.
- Send a PR for bug fixes, missing capabilities, doc improvements, or runnable examples.

For anything bigger than a small fix, an issue first to align on the approach saves cycles for both sides.

## Opening issues

Search existing issues to avoid duplicates. For bugs, include what you expected, what actually happened, your runtime and version (Node, Bun, Deno, Workers, or browser), and a minimal reproduction. A small FITS file or a short script that fetches a public archive file is ideal.

Security vulnerabilities don't go in public issues. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Pull requests

1. Fork and branch from `main`.
2. Make your changes with tests. Bug fixes need a regression test; new capabilities need decode tests, cross-checked against astropy or CFITSIO on the same input where behavior is non-trivial.
3. Run the full build, lint, and test pipeline before pushing; that's what CI runs.
4. Open the PR against `main` with a description that explains what changed and why.

Keep PRs focused. One concern per PR; split unrelated changes.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```text
feat: parse BINTABLE variable-length array columns
fix: handle BSCALE/BZERO on integer images
chore: bump turbo to 2.9.12
docs: document the RandomAccessReader interface
```

Scope is optional but helps readers (`feat(core):`, `feat(arrow):`, `fix(wcs):`).

## License

By contributing, you agree that your contributions are licensed under [Apache-2.0](LICENSE).
