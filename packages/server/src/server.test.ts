import { createEngine, defaultRegistry, type Provider } from "@loage/core";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";

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
    expect(r.value.config.server).toEqual({ port: 9000, auth: { tokens: ["t1"] } });
    expect(r.value.flows[0]?.id).toBe("hello");
  });
  it("lists every missing env var", () => {
    expect(parseConfig(yaml, "/cfg", {}, read)).toEqual({ ok: false, error: "environment variables not set: KEY, TOKEN" });
  });
  it("reports schema and flow-file problems", () => {
    expect(parseConfig("providers: [{ id: x }]", "/", {}, read).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./missing.json }]", "/", {}, read).ok).toBe(false);
    expect(parseConfig("flows: [{ file: ./hello.json }]", "/", {}, () => '{"id":1}').ok).toBe(false);
  });
});

describe("server", () => {
  const fake: Provider = { id: "m", type: "fake", capabilities: [], };
  const cfg = parseConfig(yaml, "/cfg", { KEY: "k", TOKEN: "secret" }, read);
  if (!cfg.ok) throw new Error(cfg.error);
  const engine = createEngine({ registry: defaultRegistry().registerProvider("fake", () => ({ ok: true, value: fake })), providers: cfg.value.providers, flows: cfg.value.flows });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, tokens: ["secret"] });
  const auth = { authorization: "Bearer secret" };
  const post = (id: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/v1/flows/${id}/run`, { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });

  it("serves /health without auth and guards /v1", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/v1/flows")).status).toBe(401);
    expect((await app.request("/v1/flows", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect(await (await app.request("/v1/flows", { headers: auth })).json()).toEqual({ flows: [{ id: "hello", nodes: 2 }] });
  });

  it("runs a flow", async () => {
    const res = await post("hello", { input: { name: "Ann" } });
    expect(res.status).toBe(200);
    expect((await res.json()).output.output).toBe("Hello Ann");
  });

  it("returns 404 and 400 for bad requests", async () => {
    expect((await post("nope", {})).status).toBe(404);
    expect((await app.request("/v1/flows/hello/run", { method: "POST", headers: auth, body: "{" })).status).toBe(400);
    expect((await post("hello", { input: [1] })).status).toBe(400);
  });

  it("streams events over SSE, ending with the result", async () => {
    const res = await post("hello", { input: { name: "Ann" } }, { accept: "text/event-stream" });
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect([...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(["node:start", "node:done", "node:start", "node:done", "result"]);
  });
});
