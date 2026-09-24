#!/usr/bin/env node
import { createChannels } from "@milfordai/channels";
import { loadConfig } from "@milfordai/config";
import { createEngine, defaultRegistry } from "@milfordai/core";
import { registerProviders } from "@milfordai/providers";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { fileRunStore, memoryRunStore } from "./runs.js";
import { buildOpenApi } from "./openapi.js";
import { createQueueConsumers } from "./queues.js";

// `milford-server validate [config]` checks the config and every flow, then exits without listening.
// `milford-server openapi [config]` prints the OpenAPI spec of the loaded flows.
// `milford-server runs [config]` lists the saved runs, and `runs show <runId> [config]` prints one.
const command = ["validate", "openapi", "runs"].find((candidate) => candidate === process.argv[2]);
const validateOnly = command === "validate";
const show = command === "runs" && process.argv[3] === "show";
const configArg = process.argv[command === "runs" ? (show ? 5 : 3) : command ? 3 : 2];
const configPath = configArg ?? process.env.MILFORD_CONFIG ?? "milford.config.yaml";
const die = (msg: string): never => (console.error(`milford: ${msg}`), process.exit(1));

const loaded = loadConfig(configPath);
if (!loaded.ok) die(loaded.error);
const { config, providers, flows } = (loaded as Extract<typeof loaded, { ok: true }>).value;

if (command === "runs") {
  const runs = config.server.runs;
  if (runs.store !== "file") die("runs are kept in memory, so there is nothing to read: set server.runs.store to file");
  const store = fileRunStore(runs.path, runs.max);
  if (show) {
    const id = process.argv[4] ?? die("usage: milford-server runs show <runId> [config]");
    const record = store.get(id);
    if (!record) die(`unknown run "${id}"`);
    console.log(JSON.stringify(record, null, 2));
  } else {
    for (const record of store.list({ limit: 50 })) console.log([record.runId, record.startedAt, record.flow.padEnd(20), `${String(record.ms).padStart(6)} ms`, record.ok ? "ok" : "FAILED", `${Object.keys(record.nodes).length} nodes`].join("  "));
  }
  process.exit(0);
}

const registry = registerProviders(defaultRegistry());
// The MCP SDKs are only loaded when a flow can call an MCP server.
const egress = config.mcpServers.length ? (await import("@milfordai/mcp")).registerMcp(registry, config.mcpServers) : undefined;
const engine = createEngine({ registry, providers, flows, ...config.run });
if (!engine.ok) die(engine.error);

const engineValue = (engine as Extract<typeof engine, { ok: true }>).value;
const channels = createChannels(config.channels, { engine: engineValue, log: console.log });
if (!channels.ok) die(channels.error);
const channelsValue = (channels as Extract<typeof channels, { ok: true }>).value;

// Queue consumers are validated here (so `validate` covers them) and started below, before the port opens.
const queues = await createQueueConsumers(config.queues, { engine: engineValue, log: console.log });
if (!queues.ok) die(queues.error);
const queuesValue = (queues as Extract<typeof queues, { ok: true }>).value;

if (command === "openapi") {
  process.stdout.write(JSON.stringify(buildOpenApi(engineValue.flows()), null, 2) + "\n");
  await egress?.close();
  process.exit(0);
}
if (validateOnly) {
  console.log(`milford: ${configPath} is valid (${flows.length} flow(s), ${channelsValue.length} channel(s), ${queuesValue.length} queue consumer(s))`);
  await egress?.close();
  process.exit(0);
}

// A bad token in the config stops startup here, with the message from the guard in createApp.
const app = (() => {
  try {
    return createApp({ engine: engineValue, channels: channelsValue, tokens: config.server.auth.tokens, maxBodyBytes: config.server.maxBodyBytes, idempotencyTtlMs: config.server.idempotencyTtlMs, runs: config.server.runs.store === "file" ? fileRunStore(config.server.runs.path, config.server.runs.max) : memoryRunStore(config.server.runs.max), recordRuns: config.server.runs.record, rateLimit: config.server.rateLimit });
  } catch (error) {
    return die(error instanceof Error ? error.message : String(error));
  }
})();
if (!config.server.auth.tokens.length) console.warn("milford: no auth tokens configured, the API is open");
// Queue consumers connect before the port opens: a broker that is down stops startup with a clear error.
for (const consumer of queuesValue) {
  const started = await consumer.start();
  if (!started.ok) die(started.error);
}
const server = serve({ fetch: app.fetch, port: config.server.port }, (info) => console.log(`milford: ${flows.length} flow(s), ${channelsValue.length} channel(s), ${queuesValue.length} queue consumer(s), listening on :${info.port}`));
for (const channel of channelsValue) await channel.start();
// Stop accepting, let in-flight runs finish, but never hang forever.
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    void Promise.all([...channelsValue.map((channel) => channel.stop()), ...queuesValue.map((consumer) => consumer.stop()), egress?.close()]).then(() => server.close(() => process.exit(0)));
  });
process.on("unhandledRejection", (error) => console.error("milford: unhandled rejection", error));
