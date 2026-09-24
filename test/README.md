# Milford end-to-end tests

Black-box tests of a running Milford server, from `milford.config.yaml` to HTTP. This is the
implementation of [MIL-58](https://linear.app/milfordai/issue/MIL-58/build-a-large-end-to-end-test-suite-in-its-own-repository)
and its layers (MIL-59, MIL-60, MIL-61, ...). It lives inside the core repository so the deploy
workflows can depend on it as a hard gate.

## Prerequisites

- Node 22+
- The core packages built: `pnpm build` at the repository root

## Run

```sh
pnpm install
pnpm test
```

The suite starts the real server (`packages/server/dist/cli.js`) on a free port, waits for
`/health`, runs flows over HTTP, and shuts it down.

### Targets

- Local build (default): `node packages/server/dist/cli.js`
- Any other `dist/cli.js`: `MILFORD_SERVER=/path/to/cli.js pnpm test`
- A running server: `MILFORD_TARGET=http://localhost:8081 pnpm test`

The suite stays offline: an embedded fake OpenAI-compatible provider (`src/fake-provider.ts`) answers
all `chat` and `decision` calls from a script.

## CI and releases

The suite gates every deploy:

- `ci.yml` runs it on every push and pull request (fast tier).
- `publish.yml` runs it before the npm packages are published.
- `docker.yml` runs it before the images are built and pushed.

## Layout

- `src/harness.ts` — start/stop a server, `runCli` for `validate`/`openapi`/`runs`
- `src/fake-provider.ts` — deterministic `/v1/chat/completions` server with scriptable answers, delays, errors and hangs
- `src/fixtures.ts` — config builder (auth on, fake provider, flow files)
- `src/flows.ts` — small reusable flows
- `src/client.ts` — typed HTTP helpers
- `src/timing.ts` — timing helpers: bounds and eventual conditions, never exact milliseconds
- `src/webhook.ts` — webhook signing and posting
- `src/mcp-client.ts` — minimal MCP client over stdio and HTTP
- `tests/layer1-flow-semantics.test.ts` — MIL-60 smoke
- `tests/layer2-http-contract.test.ts` — MIL-61 smoke
- `tests/layer3-config-cli.test.ts` — MIL-62 config and CLI (first slice)
- `tests/layer4-webhook.test.ts`, `tests/layer4-mcp.test.ts` — MIL-63 entry points (first slice)
- `tests/layer6-*.test.ts` — MIL-70 reliability and failure behaviour
- `tests/openai-compat.test.ts` — MIL-85 OpenAI-compatible endpoint

Test file names follow the layer numbers of the Linear issues they implement.

## Writing a test

Point the server at a temp config with `startServer`, script the fake provider, and call the HTTP
API with the helpers in `src/client.ts`. See the layer files for examples.
