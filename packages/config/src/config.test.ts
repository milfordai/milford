import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

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
const read = (p: string) => {
  if (p.endsWith("hello.json")) return flowJson;
  throw new Error("ENOENT");
};

describe("config", () => {
  it("interpolates env vars, validates, and loads flow files", () => {
    const r = parseConfig(yaml, "/cfg", { KEY: "k1", TOKEN: "t1" }, read);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.providers[0]).toMatchObject({ id: "m", apiKey: "k1" });
    expect(r.value.config.server).toMatchObject({ port: 9000, auth: { tokens: ["t1"] } });
    expect(r.value.flows[0]?.id).toBe("hello");
  });
  it("lists every missing env var", () => {
    expect(parseConfig(yaml, "/cfg", {}, read)).toEqual({ ok: false, error: "environment variables not set: KEY, TOKEN" });
  });
  it("defaults the run timeout and accepts provider resilience settings", () => {
    const r = parseConfig("providers: [{ id: a, type: openai, circuitBreaker: { failures: 3, resetMs: 5000 }, rateLimit: { perSecond: 2 } }]", "/", {}, read);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.config.run).toEqual({ timeoutMs: 60000, maxConcurrentRuns: 64 });
    expect(r.value.providers[0]).toMatchObject({ circuitBreaker: { failures: 3, resetMs: 5000 }, rateLimit: { perSecond: 2 } });
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
    const r = parseConfig("mcpServers: [{ id: crm, url: 'https://crm.example.com/mcp' }]", "/", {}, read);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.config.mcp).toMatchObject({ expose: [], transport: "stdio", port: 8090 });
    expect(r.value.config.mcpServers[0]).toEqual({ id: "crm", url: "https://crm.example.com/mcp", headers: {} });
  });
  it("keeps a flow's description and input schema", () => {
    const flow = JSON.stringify({ id: "f", description: "does a thing", input: { type: "object", properties: { text: { type: "string" } } }, nodes: [], edges: [] });
    const r = parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.flows[0]).toMatchObject({ description: "does a thing", input: { type: "object" } });
  });
  it("reads a flow written in YAML", () => {
    const flow = "id: f\nnodes:\n  - { id: out, type: output }\nedges: []\n";
    const r = parseConfig("flows: [{ file: ./f.yaml }]", "/", {}, () => flow);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.flows[0]).toMatchObject({ id: "f", nodes: [{ id: "out", type: "output" }] });
  });
  it("reads a flow's cache setting and rejects an unknown mode", () => {
    const flow = (cache: object) => JSON.stringify({ id: "f", cache, nodes: [], edges: [] });
    const ok = parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ mode: "direct", ttlMs: 60000 }));
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.value.flows[0]).toMatchObject({ cache: { mode: "direct", ttlMs: 60000 } });
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ mode: "semantic", ttlMs: 1 })).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./f.json }]", "/", {}, () => flow({ mode: "direct", ttlMs: 0 })).ok).toBe(false);
  });
  it("defaults run history to memory and resolves the file path against the config", () => {
    const d = parseConfig("{}", "/cfg", {}, read);
    if (!d.ok) throw new Error(d.error);
    expect(d.value.config.server.runs).toMatchObject({ store: "memory", max: 200, record: "trace", path: "/cfg/milford-runs.jsonl" });
    const f = parseConfig("server: { runs: { store: file, path: history/runs.jsonl, record: full } }", "/cfg", {}, read);
    if (!f.ok) throw new Error(f.error);
    expect(f.value.config.server.runs).toMatchObject({ store: "file", path: "/cfg/history/runs.jsonl", record: "full" });
    expect(parseConfig("server: { runs: { record: everything } }", "/cfg", {}, read).ok).toBe(false);
  });
});
