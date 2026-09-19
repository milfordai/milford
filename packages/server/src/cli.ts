#!/usr/bin/env node
import { createEngine, defaultRegistry } from "@loage/core";
import { registerProviders } from "@loage/providers";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const path = process.argv[2] ?? process.env.LOAGE_CONFIG ?? "loage.config.yaml";
const die = (msg: string): never => (console.error(`loage: ${msg}`), process.exit(1));

const loaded = loadConfig(path);
if (!loaded.ok) die(loaded.error);
const { config, providers, flows } = (loaded as Extract<typeof loaded, { ok: true }>).value;

const engine = createEngine({ registry: registerProviders(defaultRegistry()), providers, flows });
if (!engine.ok) die(engine.error);

const app = createApp({ engine: (engine as Extract<typeof engine, { ok: true }>).value, tokens: config.server.auth.tokens, runTimeoutMs: config.server.runTimeoutMs, maxConcurrentRuns: config.server.maxConcurrentRuns, maxBodyBytes: config.server.maxBodyBytes });
if (!config.server.auth.tokens.length) console.warn("loage: no auth tokens configured, the API is open");
const server = serve({ fetch: app.fetch, port: config.server.port }, (i) => console.log(`loage: ${flows.length} flow(s), listening on :${i.port}`));
// Stop accepting, let in-flight runs finish, but never hang forever.
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => process.exit(0));
  });
process.on("unhandledRejection", (e) => console.error("loage: unhandled rejection", e));
