# Loage

A headless workflow engine for typed decisions, model calls and HTTP calls, wired in a graph. A TypeScript core library plus a thin HTTP server, configured as code and deployed with Docker. It is not an agent framework: no agent loops.

- `@loage/core`: flows, executor, nodes, provider port. No I/O, no vendor knowledge.
- `@loage/providers`: OpenAI (and compatible), Anthropic, Jev, generic HTTP, SageMaker.
- `@loage/server`: Hono server with bearer auth and SSE.
- `@loage/mcp`: MCP server that exposes flows as tools to external LLMs.
- `@loage/config`: the config loader shared by both servers.

```bash
pnpm install && pnpm build && pnpm test
LOAGE_TOKEN=change-me ANTHROPIC_API_KEY=... node packages/server/dist/cli.js examples/flows/loage.config.yaml
curl -s localhost:8080/v1/flows/hello/run -H "authorization: Bearer change-me" -d '{"input":{"name":"Ann"}}'
```

Documentation is in [`docs/`](docs) (`cd docs && mint dev`). Examples are in [`examples/`](examples), including a home-automation flow that runs with no hardware.

Licensed under Apache-2.0.
