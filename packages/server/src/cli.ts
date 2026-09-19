#!/usr/bin/env node
import { createChannels } from "@milfordai/channels";
import { loadConfig } from "@milfordai/config";
import { createEngine, defaultRegistry } from "@milfordai/core";
import { registerProviders } from "@milfordai/providers";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { fileRunStore, memoryRunStore } from "./runs.js";
import { buildOpenApi } from "./openapi.js";


// `milford-server validate [config]` checks the config and every flow, then exits without listening.
// `milford-server openapi [config]` prints the OpenAPI spec of the loaded flows.
// `milford-server runs [config]` lists the saved runs, and `runs show <runId> [config]` prints one.
const command = ["validate", "openapi", "runs"].find((c) => c === process.argv[2]);
const validateOnly = command === "validate";
const show = command === "runs" && process.argv[3] === "show";
const configArg = process.argv[command === "runs" ? (show ? 5 : 3) : command ? 3 : 2];
const path = configArg ?? process.env.MILFORD_CONFIG ?? "milford.config.yaml";
const die = (msg: string): never => (console.error(`milford: ${msg}`), process.exit(1));

const loaded = loadConfig(path);
if (!loaded.ok) die(loaded.error);
const { config, providers, flows } = (loaded as Extract<typeof loaded, { ok: true }>).value;

if (command === "runs") {
  const runs = config.server.runs;
  if (runs.store !== "file") die("runs are kept in memory, so there is nothing to read: set server.runs.store to file");
  const store = fileRunStore(runs.path, runs.max);
  if (show) {
    const id = process.argv[4] ?? die("usage: milford-server runs show <runId> [config]");
    const r = store.get(id);
    if (!r) die(`unknown run "${id}"`);
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const r of store.list({ limit: 50 })) console.log([r.runId, r.startedAt, r.flow.padEnd(20), `${String(r.ms).padStart(6)} ms`, r.ok ? "ok" : "FAILED", `${Object.keys(r.nodes).length} nodes`].join("  "));
  }
  process.exit(0);
}

const registry = registerProviders(defaultRegistry());
// The MCP SDKs are only loaded when a flow can call an MCP server.
const egress = config.mcpServers.length ? (await import("@milfordai/mcp")).registerMcp(registry, config.mcpServers) : undefined;
const engine = createEngine({ registry, providers, flows, ...config.run });
if (!engine.ok) die(engine.error);

const eng = (engine as Extract<typeof engine, { ok: true }>).value;
const channels = createChannels(config.channels, { engine: eng, log: console.log });
if (!channels.ok) die(channels.error);
const chs = (channels as Extract<typeof channels, { ok: true }>).value;

if (command === "openapi") {
  process.stdout.write(JSON.stringify(buildOpenApi(eng.flows()), null, 2) + "\n");
  await egress?.close();
  process.exit(0);
}
if (validateOnly) {
  console.log(`milford: ${path} is valid (${flows.length} flow(s), ${chs.length} channel(s))`);
  await egress?.close();
  process.exit(0);
}

const app = createApp({ engine: eng, channels: chs, tokens: config.server.auth.tokens, maxBodyBytes: config.server.maxBodyBytes, idempotencyTtlMs: config.server.idempotencyTtlMs, runs: config.server.runs.store === "file" ? fileRunStore(config.server.runs.path, config.server.runs.max) : memoryRunStore(config.server.runs.max), recordRuns: config.server.runs.record });
if (!config.server.auth.tokens.length) console.warn("milford: no auth tokens configured, the API is open");
const server = serve({ fetch: app.fetch, port: config.server.port }, (i) => console.log(`milford: ${flows.length} flow(s), ${chs.length} channel(s), listening on :${i.port}`));
for (const ch of chs) await ch.start();
// Stop accepting, let in-flight runs finish, but never hang forever.
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    void Promise.all([...chs.map((c) => c.stop()), egress?.close()]).then(() => server.close(() => process.exit(0)));
  });
process.on("unhandledRejection", (e) => console.error("milford: unhandled rejection", e));
