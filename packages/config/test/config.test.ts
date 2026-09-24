import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";

const yaml = `
providers:
  - { id: m, type: fake, apiKey: "\${KEY}" }
flows:
  - file: ./flows/hello.json
server:
  port: 9000
  auth: { tokens: ["\${TOKEN}"] }
`;
const flowJson = JSON.stringify({ id: "hello", nodes: [{ id: "p", type: "prompt", config: { template: "Hello {{input.name}}" } }, { id: "out", type: "output" }], edges: [{ from: "p", to: "out" }] });
const read = (path: string) => {
  if (path.endsWith("hello.json")) return flowJson;
  throw new Error("ENOENT");
};

describe("config", () => {
  it("interpolates env vars, validates, and loads flow files", () => {
    const result = parseConfig(yaml, "/cfg", { KEY: "k1", TOKEN: "t1" }, read);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.providers[0]).toMatchObject({ id: "m", apiKey: "k1" });
    expect(result.value.config.server).toMatchObject({ port: 9000, auth: { tokens: ["t1"] } });
    expect(result.value.flows[0]?.id).toBe("hello");
  });
  it("lists every missing env var", () => {
    expect(parseConfig(yaml, "/cfg", {}, read)).toEqual({ ok: false, error: "environment variables not set: KEY, TOKEN" });
  });
  it("defaults the run timeout and accepts provider resilience settings", () => {
    const result = parseConfig("providers: [{ id: a, type: openai, circuitBreaker: { failures: 3, resetMs: 5000 }, rateLimit: { perSecond: 2 } }]", "/", {}, read);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.config.run).toEqual({ timeoutMs: 60000, maxConcurrentRuns: 64 });
    expect(result.value.providers[0]).toMatchObject({ circuitBreaker: { failures: 3, resetMs: 5000 }, rateLimit: { perSecond: 2 } });
    expect(parseConfig("providers: [{ id: a, type: x, rateLimit: { perSecond: 0 } }]", "/", {}, read).ok).toBe(false);
  });
  it("reports schema and flow-file problems", () => {
    expect(parseConfig("providers: [{ id: x }]", "/", {}, read).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./missing.json }]", "/", {}, read).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./hello.json }]", "/", {}, () => '{"id":1}').ok).toBe(false);
  });
});

describe("mcp config", () => {
  it("defaults to exposing nothing over stdio, and accepts mcp servers", () => {
    const result = parseConfig("mcpServers: [{ id: crm, url: 'https://crm.example.com/mcp' }]", "/", {}, read);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.config.mcp).toMatchObject({ expose: [], transport: "stdio", port: 8090 });
    expect(result.value.config.mcpServers[0]).toEqual({ id: "crm", url: "https://crm.example.com/mcp", headers: {} });
  });
  it("keeps a flow's description and input schema", () => {
    const flow = JSON.stringify({ id: "f", description: "does a thing", input: { type: "object", properties: { text: { type: "string" } } }, nodes: [], edges: [] });
    const result = parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.flows[0]).toMatchObject({ description: "does a thing", input: { type: "object" } });
  });
  it("reads a flow written in YAML", () => {
    const flow = "id: f\nnodes:\n  - { id: out, type: output }\nedges: []\n";
    const result = parseConfig("flows: [{ file: ./f.yaml }]", "/", {}, () => flow);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.flows[0]).toMatchObject({ id: "f", nodes: [{ id: "out", type: "output" }] });
  });
  it("reads a flow's cache setting and rejects an unknown mode", () => {
    const flow = (cache: object) => JSON.stringify({ id: "f", cache, nodes: [], edges: [] });
    const result = parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ mode: "direct", ttlMs: 60000 }));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.flows[0]).toMatchObject({ cache: { mode: "direct", ttlMs: 60000 } });
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ mode: "semantic", ttlMs: 1 })).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ mode: "direct", ttlMs: 0 })).ok).toBe(false);
  });
  it("reads the full retry policy and rejects unknown fields", () => {
    const flow = (retry: object) => JSON.stringify({ id: "f", nodes: [{ id: "p", type: "prompt", retry }], edges: [] });
    const result = parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ attempts: 5, backoffMs: 100, multiplier: 3, maxBackoffMs: 60000, jitterMs: 20, stopDelayMs: 30000, on: "infra" }));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.flows[0]!.nodes[0]).toMatchObject({ retry: { attempts: 5, backoffMs: 100, multiplier: 3, maxBackoffMs: 60000, jitterMs: 20, stopDelayMs: 30000, on: "infra" } });
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ attempts: 5, on: "everything" })).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ attempts: 0 })).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ attempts: 2, multiplier: 0 })).ok).toBe(false);
  });
  it("defaults run history to memory and resolves the file path against the config", () => {
    const defaultResult = parseConfig("{}", "/cfg", {}, read);
    if (!defaultResult.ok) throw new Error(defaultResult.error);
    expect(defaultResult.value.config.server.runs).toMatchObject({ store: "memory", max: 200, record: "trace", path: "/cfg/milford-runs.jsonl" });
    const fileResult = parseConfig("server: { runs: { store: file, path: history/runs.jsonl, record: full } }", "/cfg", {}, read);
    if (!fileResult.ok) throw new Error(fileResult.error);
    expect(fileResult.value.config.server.runs).toMatchObject({ store: "file", path: "/cfg/history/runs.jsonl", record: "full" });
    expect(parseConfig("server: { runs: { record: everything } }", "/cfg", {}, read).ok).toBe(false);
  });
  it("reads an optional rate limit and rejects a non-positive one", () => {
    expect(parseConfig("{}", "/", {}, read).ok && (parseConfig("{}", "/", {}, read) as { value: { config: { server: { rateLimit?: unknown } } } }).value.config.server.rateLimit).toBeUndefined();
    const result = parseConfig("server: { rateLimit: { perSecond: 5, burst: 10 } }", "/", {}, read);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.config.server.rateLimit).toEqual({ perSecond: 5, burst: 10 });
    expect(parseConfig("server: { rateLimit: { perSecond: 0 } }", "/", {}, read).ok).toBe(false);
  });
});
