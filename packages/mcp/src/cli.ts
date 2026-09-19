#!/usr/bin/env node
import { loadConfig } from "@milfordai/config";
import { createEngine, defaultRegistry } from "@milfordai/core";
import { registerProviders } from "@milfordai/providers";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerMcp } from "./egress.js";
import { serveHttp } from "./http.js";
import { createMcpFactory } from "./server.js";

// stdout carries the protocol when serving stdio, so everything human-readable goes to stderr.
const log = console.error;
const die = (msg: string): never => (log(`milford-mcp: ${msg}`), process.exit(1));

const path = process.argv[2] ?? process.env.MILFORD_CONFIG ?? "milford.config.yaml";
const loaded = loadConfig(path);
if (!loaded.ok) die(loaded.error);
const { config, providers, flows } = (loaded as Extract<typeof loaded, { ok: true }>).value;
const mcp = config.mcp;

const registry = registerProviders(defaultRegistry());
const egress = registerMcp(registry, config.mcpServers);
const engine = createEngine({ registry, providers, flows, ...config.run });
if (!engine.ok) die(engine.error);
const factory = createMcpFactory((engine as Extract<typeof engine, { ok: true }>).value, { expose: mcp.expose, log });
if (!factory.ok) die(factory.error);
const make = (factory as Extract<typeof factory, { ok: true }>).value;

let close: () => Promise<void>;
if (mcp.transport === "stdio") {
  const handle = serveStdio(make);
  close = async () => void (await handle.close());
  log(`milford-mcp: ${mcp.expose.length} tool(s) over stdio`);
} else {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(mcp.host);
  if (!mcp.auth.tokens.length && !loopback) die("mcp.auth.tokens is required when the HTTP transport listens beyond localhost");
  const http = serveHttp(make, { port: mcp.port, host: mcp.host, tokens: mcp.auth.tokens });
  close = http.close;
  log(`milford-mcp: ${mcp.expose.length} tool(s) over HTTP on ${mcp.host}:${mcp.port}/mcp`);
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    void Promise.all([close(), egress.close()]).then(() => process.exit(0));
  });
