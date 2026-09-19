# AGENTS.md

Loage is a headless intelligent workflow engine: a TypeScript core library plus a thin HTTP server, configured as code and deployed with Docker. It is not an agent framework (no LangChain, no agent loops). The full design lives in `.claude/PLAN.md` (local, gitignored); the summary below is what agents need day to day.

## Architecture rules
- `packages/core` has zero I/O and zero vendor knowledge. It defines ports (`Provider`, `FlowSource`, `Clock`, `Logger`, `Cache`, later `Transport`, `MessageBus`, `Ingress`). Never import Jev/Typesafe, a vendor SDK or a broker client into core. CI fails on `typesafe`/`jev` in `packages/core`.
- Vendors are adapters in `packages/providers` (Jev is one adapter among several, never required).
- Nodes and providers are registered by `type` (registry + strategy). No growing `switch`.
- Nodes and providers return results (`{ok, value} | {ok: false, error}`), they do not throw.
- Flows are plain JSON. No UI types or positions in the model.
- Dependencies stay minimal: `zod`, `yaml`, `hono`, `vitest`. Providers use plain `fetch`.
- Prefer the smallest change that works; no speculative abstractions.

## Commands
- `pnpm install`, `pnpm -r build`, `pnpm -r test`
- Docs: `cd docs && mint dev`, `mint validate`, `mint broken-links`

## Git flow
- Long-lived branches: `main` (releases only, tagged) and `dev` (integration).
- Work happens on `feature/<name>` branched from `dev`, merged back into `dev` with `--no-ff` (or a PR).
- `release/<version>` branches from `dev`, merges into `main` and back into `dev`, tagged `v<version>`.
- `hotfix/<name>` branches from `main`, merges into `main` and `dev`.
- Never commit directly to `main` or `dev`. Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
- Docs changes ship in the same branch as the code change they describe.

## Documentation (Mintlify)
- Docs are in `docs/` (`docs.json`, `*.mdx`). Every user-visible change (node, provider, config key, endpoint, CLI flag) updates the docs in the same branch. New pages must be added to `docs.json` navigation.
- Before writing docs, use the `mintlify` skill and search current Mintlify docs through the `mintlify-index` MCP server (`.mcp.json`) rather than relying on memory.
- Style: second person, active voice, sentence-case headings, no marketing words, language tag on every code block, root-relative internal links without extensions. Mark uncertainty with `{/* TODO: ... */}`.
- Before finishing docs work run `mint validate` and `mint broken-links`.
