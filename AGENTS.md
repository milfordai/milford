# AGENTS.md

Milford is a headless intelligent workflow engine: a TypeScript core library plus a thin HTTP server, configured as code and deployed with Docker. It is not an agent framework (no LangChain, no agent loops). The full design lives in `.claude/PLAN.md` (local, gitignored); the summary below is what agents need day to day.

## Architecture rules
- `packages/core` has zero I/O and zero vendor knowledge. It defines ports (`Provider`, `FlowSource`, `Clock`, `Logger`, `Cache`, later `Transport`, `MessageBus`). Never import Jev/Typesafe, a vendor SDK or a broker client into core. CI fails on `typesafe`/`jev` in `packages/core`.
- Vendors are adapters in `packages/providers` (Jev is one adapter among several, never required).
- Nodes and providers are registered by `type` (registry + strategy). No growing `switch`.
- Nodes and providers return results (`{ok, value} | {ok: false, error}`), they do not throw.
- Flows are plain JSON. No UI types or positions in the model.
- Dependencies stay minimal: `zod`, `yaml`, `hono`, `vitest`. Providers use plain `fetch`.
- Prefer the smallest change that works; no speculative abstractions.

## Commands
- `pnpm install`, `pnpm -r build`, `pnpm -r test`

## Git flow
- Long-lived branches: `main` (releases only, tagged) and `dev` (integration).
- Work happens on `feature/<name>` branched from `dev`, merged back into `dev` with `--no-ff` (or a PR).
- `release/<version>` branches from `dev`, merges into `main` and back into `dev`, tagged `v<version>`.
- `hotfix/<name>` branches from `main`, merges into `main` and `dev`.
- Never commit directly to `main` or `dev`. Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
- A user-visible change also needs a docs change: open a matching pull request in `milfordai/docs` and link the two (see Documentation).

## Documentation and other repositories
- This repository is the open-source core. The org `milfordai` also has `docs` (the Mintlify site) and `examples` (runnable examples, except `examples/quickstart` which stays here), both private for now.
- Every user-visible change (node, provider, config key, endpoint, CLI flag) needs a matching pull request in `milfordai/docs`. Link the two pull requests, and merge the code first.
- `packages/server/openapi.yaml` is the source of truth for the HTTP API and stays here. A server test fails when a route is missing from it. The docs repository gets a copy at release time.
- Docs style and the Mintlify workflow are in the docs repository's `AGENTS.md`.
