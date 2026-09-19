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

The documentation is in a separate repository (`milfordai/docs`, Mintlify). A change that users can see (a node, a provider, a config key, an endpoint or a CLI flag) needs a matching pull request there. Link the two pull requests. `packages/server/openapi.yaml` stays here as the source of truth for the HTTP API: update it in the same pull request as the route, and the docs repository gets a copy at release time.

Runnable examples are in `milfordai/examples`, except `examples/quickstart`, which the README and the Docker instructions use.

## Reporting bugs

Open an [issue](https://github.com/milfordai/milford/issues) with the version, your config (without secrets) and the steps to reproduce. For security problems, see [SECURITY.md](SECURITY.md).
