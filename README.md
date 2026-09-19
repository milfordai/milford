# Loage

[![CI](https://github.com/iwandejong/loage.ai/actions/workflows/ci.yml/badge.svg)](https://github.com/iwandejong/loage.ai/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/iwandejong/loage.ai)](https://github.com/iwandejong/loage.ai/releases)
[![License](https://img.shields.io/github/license/iwandejong/loage.ai)](LICENSE)

## Intelligent workflows as code: typed decisions, model calls and HTTP calls in a graph

Loage is a headless workflow engine. You describe a flow as plain JSON: small steps such as a typed decision, a model call, a template or an HTTP call, wired in a graph. Loage runs it behind an HTTP API, an MCP server or as a TypeScript library. It is not an agent framework: there are no agent loops, so a flow is a fixed graph that you can read, version in git and test.

## Quick Start

**Go from a clone to a running flow in a minute. No API key needed.**

**Step 1:** Start Loage

```bash
git clone https://github.com/iwandejong/loage.ai && cd loage.ai
docker build -t loage .
docker run -p 8080:8080 -e LOAGE_TOKEN=change-me -v "$PWD/examples/quickstart:/config:ro" loage
```

Without Docker, use Node 22 and pnpm:

```bash
pnpm install && pnpm build
LOAGE_TOKEN=change-me node packages/server/dist/cli.js examples/quickstart/loage.config.yaml
```

**Step 2:** Run a flow

```bash
curl -s localhost:8080/v1/flows/hello/run \
  -H "authorization: Bearer change-me" \
  -d '{"input": {"name": "Ann"}}'
```

The response holds the result of every node and the flow `output`, here `"Hello Ann!"`.

**Step 3:** Add a model

A `decision` node asks a provider a typed question and returns a value you can branch on. Add a provider to `loage.config.yaml`:

```yaml
providers:
  - { id: main-llm, type: anthropic, apiKey: "${ANTHROPIC_API_KEY}", model: claude-sonnet-5 }
```

Then use it in a flow. Edges with `when` route on the answer, and a low-confidence answer becomes `none_of_these`:

```json
{ "id": "team", "type": "decision", "config": {
    "provider": "main-llm", "kind": "choice",
    "prompt": "Which team should handle this message?",
    "options": ["billing", "technical", "sales"],
    "state": "{{input.text}}", "minConfidence": 0.6 } }
```

```json
{ "from": "team", "to": "billing-reply", "when": { "path": "data.choice", "op": "eq", "value": "billing" } }
```

The complete flow is [`examples/flows/triage.json`](examples/flows/triage.json). Switching the provider to an OpenAI-compatible server or a local classifier is a config change, and the flow stays the same.

**That's it!** Your flow runs behind an authenticated API with streaming, idempotent retries and run limits.

**Complete guides:**

- [Quickstart](docs/quickstart.mdx) - HTTP server and library use
- [Flows](docs/concepts/flows.mdx) and [Decisions](docs/concepts/decisions.mdx) - the model behind it

---

## Key Features

### Flows

- **[Plain JSON graphs](docs/concepts/flows.mdx)** - No UI types in the model. Write JSON by hand or build it with the TypeScript `flow()` builder.
- **[Parallel execution](docs/concepts/flows.mdx)** - Nodes in a level run concurrently. Failed branches are isolated and reported in the result.
- **[Branching](docs/concepts/flows.mdx)** - Route on any field of a node result, with `join: "all"` when a node needs every input.
- **[Retries, timeouts and caching](docs/concepts/flows.mdx)** - Per node, with abort signals that reach every network call.
- **[Built-in nodes](docs/nodes/reference.mdx)** - `input`, `prompt`, `llm`, `decision`, `http`, `mcp` and `output`. Add your own with one `registerNode` call.

### Decisions and models

- **[Typed decisions](docs/concepts/decisions.mdx)** - `choice`, `score` and `noul` answers instead of parsed free text, with confidence gating and a `none_of_these` option.
- **[Providers](docs/providers/overview.mdx)** - OpenAI and any OpenAI-compatible server, Anthropic, Jev, and a generic HTTP endpoint for your own classifier.
- **[Fallback, circuit breaker and rate limit](docs/providers/overview.mdx)** - Prefer a local provider and fall back to a cloud one, or the reverse.
- **[Fan-out](docs/concepts/decisions.mdx)** - Decisions in the same level run together, and providers that support batching receive them as one request.

### Interfaces

- **[HTTP API](docs/reference/http-api.mdx)** - Run flows with server-sent events, `Idempotency-Key` retries, bearer auth and an [OpenAPI 3.1 spec](docs/openapi.yaml).
- **[MCP server](docs/guides/mcp.mdx)** - Expose chosen flows as tools to external LLMs over stdio or Streamable HTTP. Nothing is exposed by default.
- **[MCP client](docs/guides/mcp.mdx)** - The `mcp` node calls tools on other MCP servers, and a decision can choose the tool from an allow list.
- **[Channels](docs/guides/channels.mdx)** - Slack (Socket Mode), Telegram and signed webhooks. Access is deny by default.

### Deploy and operate

- **[Config as code](docs/reference/config.mdx)** - One YAML file with `${ENV}` interpolation and a generated JSON Schema for editor completion.
- **[Docker](docs/reference/deployment.mdx)** - Images for `linux/amd64` and `linux/arm64`, one for the HTTP server and one for the MCP server. No database.
- **[Run limits](docs/reference/config.mdx)** - A shared timeout and concurrency cap, JSON logs and a graceful shutdown.
- **[Vendor neutral](AGENTS.md)** - The core has no I/O and no vendor code. CI fails if `typesafe` or `jev` appears in it.

---

## Ways to Run It

| | Use it for | Start |
| --- | --- | --- |
| **HTTP server** | Any language or framework calling flows over REST | `node packages/server/dist/cli.js loage.config.yaml` |
| **MCP server** | LLM clients such as Claude Desktop or Claude Code | `node packages/mcp/dist/cli.js loage.config.yaml` |
| **Library** | Embedding the engine in a TypeScript app | `createEngine({ registry, providers, flows })` from `@loage/core` |

The HTTP and MCP servers are separate programs that read the same config file and can run side by side. For a queue-driven service such as a Spring app on IBM MQ, keep the queue in that service and call Loage over HTTP: see [enterprise integration](docs/guides/enterprise-integration.mdx).

---

## Repository Structure

```text
loage.ai/
├── packages/
│   ├── core/            # Flow compiler, executor, nodes, provider port. No I/O
│   ├── config/          # YAML config loader and JSON Schema, shared by both servers
│   ├── providers/       # OpenAI-compatible, Anthropic, Jev and HTTP adapters
│   ├── server/          # HTTP server (Hono): API, SSE, idempotency, webhooks
│   ├── channels/        # Slack, Telegram and webhook adapters
│   └── mcp/             # MCP server and the mcp node
├── examples/            # quickstart, flows, home automation, error classification
├── docs/                # Documentation (Mintlify) and the OpenAPI spec
├── Dockerfile           # Targets: server (default) and mcp
└── docker-compose.yml
```

---

## Examples

- [`examples/quickstart`](examples/quickstart) - The config from the Quick Start.
- [`examples/flows`](examples/flows) - One flow per idea: templates, a summarizing model call, decision routing and a webhook call.
- [`examples/home-automation`](examples/home-automation) - A free-text command turned into device actions by a fan-out of small decisions, with a fake device server so it runs without hardware. See the [guide](docs/guides/home-automation.mdx).
- [`examples/error-classification`](examples/error-classification) - Classify application errors and detect repeats of earlier ones.

---

## Status

Loage is at v0.0.1. The config format can still change. The Slack and Telegram adapters and the provider adapters are tested against mocked network calls, not live services, so try them with a test workspace and test keys first.

---

## Development

```bash
pnpm install
pnpm build        # builds every package with Turborepo
pnpm typecheck
pnpm test
```

Docs live in `docs/` (`cd docs && mint dev`, which needs Node 22 or another LTS version). Work happens on `feature/<name>` branches from `dev`, and releases are tagged from `main`. See [AGENTS.md](AGENTS.md) for the architecture rules and the git flow.

## License

Apache-2.0. See [LICENSE](LICENSE).
