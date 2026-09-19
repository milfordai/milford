#!/usr/bin/env node
import { createChannels } from "@milfordai/channels";
import { loadConfig } from "@milfordai/config";
import { createEngine, defaultRegistry } from "@milfordai/core";
import { registerProviders } from "@milfordai/providers";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";


// `milford-server validate [config]` checks the config and every flow, then exits without listening.
const validateOnly = process.argv[2] === "validate";
const path = process.argv[validateOnly ? 3 : 2] ?? process.env.MILFORD_CONFIG ?? "milford.config.yaml";
const die = (msg: string): never => (console.error(`milford: ${msg}`), process.exit(1));

const loaded = loadConfig(path);
if (!loaded.ok) die(loaded.error);
const { config, providers, flows } = (loaded as Extract<typeof loaded, { ok: true }>).value;

const registry = registerProviders(defaultRegistry());
// The MCP SDKs are only loaded when a flow can call an MCP server.
const egress = config.mcpServers.length ? (await import("@milfordai/mcp")).registerMcp(registry, config.mcpServers) : undefined;
const engine = createEngine({ registry, providers, flows, ...config.run });
if (!engine.ok) die(engine.error);

const eng = (engine as Extract<typeof engine, { ok: true }>).value;
const channels = createChannels(config.channels, { engine: eng, log: console.log });
if (!channels.ok) die(channels.error);
const chs = (channels as Extract<typeof channels, { ok: true }>).value;

if (validateOnly) {
  console.log(`milford: ${path} is valid (${flows.length} flow(s), ${chs.length} channel(s))`);
  await egress?.close();
  process.exit(0);
}

const app = createApp({ engine: eng, channels: chs, tokens: config.server.auth.tokens, maxBodyBytes: config.server.maxBodyBytes, idempotencyTtlMs: config.server.idempotencyTtlMs });
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
