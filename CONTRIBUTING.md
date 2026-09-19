# Contributing

Thanks for helping with Milford.

## Set up

You need Node 22 and pnpm.

```bash
pnpm install
pnpm build        # builds every package with Turborepo
pnpm typecheck
pnpm test
```

A pre-commit hook runs the typecheck and the tests.

## Working on a change

- Branch from `dev` as `feature/<name>` and open a pull request into `dev`. `main` holds tagged releases only.
- Use conventional commit messages: `feat:`, `fix:`, `docs:`, `chore:`.
- Add or update tests for behavior you change. Providers are tested with a mocked `fetch`.
- Keep the core free of I/O and vendor code. CI fails if `typesafe` or `jev` appears in `packages/core`.
- Prefer the smallest change that works. See [AGENTS.md](AGENTS.md) for the architecture rules.

## Documentation

The documentation site is kept in a separate repository. If your change is visible to users (a node, a provider, a config key, an endpoint or a CLI flag), describe the docs change in your pull request and a maintainer updates the site. Update `packages/server/openapi.yaml` in the same pull request as an HTTP route: a test fails when a route is missing from it.

The larger runnable examples are in a separate repository that is not public yet. `examples/quickstart` stays here, because the README and the Docker instructions use it.

## Reporting bugs

Open an [issue](https://github.com/milfordai/milford/issues) with the version, your config (without secrets) and the steps to reproduce. For security problems, see [SECURITY.md](SECURITY.md).
