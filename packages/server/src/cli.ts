#!/usr/bin/env node
import { createChannels } from "@loage/channels";
import { loadConfig } from "@loage/config";
import { createEngine, defaultRegistry } from "@loage/core";
import { registerProviders } from "@loage/providers";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";


const path = process.argv[2] ?? process.env.LOAGE_CONFIG ?? "loage.config.yaml";
const die = (msg: string): never => (console.error(`loage: ${msg}`), process.exit(1));

const loaded = loadConfig(path);
if (!loaded.ok) die(loaded.error);
const { config, providers, flows } = (loaded as Extract<typeof loaded, { ok: true }>).value;

const engine = createEngine({ registry: registerProviders(defaultRegistry()), providers, flows });
if (!engine.ok) die(engine.error);

const eng = (engine as Extract<typeof engine, { ok: true }>).value;
const channels = createChannels(config.channels, { engine: eng, log: console.log, runTimeoutMs: config.server.runTimeoutMs });
if (!channels.ok) die(channels.error);
const chs = (channels as Extract<typeof channels, { ok: true }>).value;

const app = createApp({ engine: eng, channels: chs, tokens: config.server.auth.tokens, runTimeoutMs: config.server.runTimeoutMs, maxConcurrentRuns: config.server.maxConcurrentRuns, maxBodyBytes: config.server.maxBodyBytes, idempotencyTtlMs: config.server.idempotencyTtlMs });
if (!config.server.auth.tokens.length) console.warn("loage: no auth tokens configured, the API is open");
const server = serve({ fetch: app.fetch, port: config.server.port }, (i) => console.log(`loage: ${flows.length} flow(s), ${chs.length} channel(s), listening on :${i.port}`));
for (const ch of chs) await ch.start();
// Stop accepting, let in-flight runs finish, but never hang forever.
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    void Promise.all(chs.map((c) => c.stop())).then(() => server.close(() => process.exit(0)));
  });
process.on("unhandledRejection", (e) => console.error("loage: unhandled rejection", e));
