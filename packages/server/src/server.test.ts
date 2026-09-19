import { createChannels } from "@milfordai/channels";
import { createEngine, defaultRegistry, type Provider } from "@milfordai/core";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { buildOpenApi } from "./openapi.js";
import { parseConfig } from "@milfordai/config";

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

describe("server", () => {
  const fake: Provider = { id: "m", type: "fake", capabilities: [], };
  const cfg = parseConfig(yaml, "/cfg", { KEY: "k", TOKEN: "secret" }, read);
  if (!cfg.ok) throw new Error(cfg.error);
  const engine = createEngine({ registry: defaultRegistry().registerProvider("fake", () => ({ ok: true, value: fake })), providers: cfg.value.providers, flows: cfg.value.flows });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, tokens: ["secret"], log: () => {}, maxBodyBytes: 200 });
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

  it("rejects oversized bodies with 413", async () => {
    expect((await post("hello", { input: { pad: "x".repeat(500) } })).status).toBe(413);
  });

  it("sheds load with 503 when too many runs are active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = createEngine({
      registry: defaultRegistry().registerNode("slow", { run: async () => (await gate, { success: true }) }),
      flows: [{ id: "s", nodes: [{ id: "a", type: "slow" }], edges: [] }],
      maxConcurrentRuns: 1,
    });
    if (!slow.ok) throw new Error(slow.error);
    const a = createApp({ engine: slow.value, log: () => {} });
    const first = a.request("/v1/flows/s/run", { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 10));
    const second = await a.request("/v1/flows/s/run", { method: "POST", body: "{}" });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
  });

  it("logs one JSON line per run", async () => {
    const lines: string[] = [];
    const a = createApp({ engine: engine.value, log: (l) => lines.push(l) });
    await a.request("/v1/flows/hello/run", { method: "POST", body: JSON.stringify({ input: { name: "Ann" } }) });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "run", flow: "hello", ok: true });
  });

  it("streams events over SSE, ending with the result", async () => {
    const res = await post("hello", { input: { name: "Ann" } }, { accept: "text/event-stream" });
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect([...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(["node:start", "node:done", "node:start", "node:done", "result"]);
  });
});

describe("webhook channels", () => {
  const secret = "0123456789abcdef";
  const engine = createEngine({ registry: defaultRegistry(), flows: [JSON.parse(flowJson)] });
  if (!engine.ok) throw new Error(engine.error);
  const chs = createChannels([{ id: "w", type: "webhook", flow: "hello", secret }], { engine: engine.value, log: () => {} });
  if (!chs.ok) throw new Error(chs.error);
  const app = createApp({ engine: engine.value, tokens: ["bearer"], channels: chs.value, log: () => {} });
  const signed = (body: string, key = secret) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { "x-milford-timestamp": ts, "x-milford-signature": `sha256=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}` };
  };

  it("accepts a signed request without a bearer token, and rejects a bad one", async () => {
    const body = JSON.stringify({ name: "Ann" });
    const ok = await app.request("/hooks/w", { method: "POST", body, headers: signed(body) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).output).toBe("Hello Ann");
    expect((await app.request("/hooks/w", { method: "POST", body, headers: signed(body, "wrong-secret-value!") })).status).toBe(401);
  });
  it("404s unknown hooks and still guards /v1", async () => {
    expect((await app.request("/hooks/nope", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/v1/flows")).status).toBe(401);
  });
});

describe("idempotency", () => {
  const counted = () => {
    let runs = 0;
    const engine = createEngine({
      registry: defaultRegistry().registerNode("count", { run: async () => ({ success: true, output: String(++runs) }) }).registerNode("fail", { run: async () => ({ success: false, error: "no" }) }),
      flows: [
        { id: "c", nodes: [{ id: "a", type: "count" }], edges: [] },
        { id: "f", nodes: [{ id: "a", type: "fail" }], edges: [] },
      ],
    });
    if (!engine.ok) throw new Error(engine.error);
    return { app: createApp({ engine: engine.value, log: () => {} }), runs: () => runs };
  };
  const post = (app: ReturnType<typeof createApp>, flow: string, input: object, key?: string) =>
    app.request(`/v1/flows/${flow}/run`, { method: "POST", headers: key ? { "idempotency-key": key } : {}, body: JSON.stringify({ input }) });

  it("replays the first result for the same key and input", async () => {
    const { app, runs } = counted();
    const first = await post(app, "c", { n: 1 }, "msg-1");
    const again = await post(app, "c", { n: 1 }, "msg-1");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect((await again.json()).runId).toBe((await first.json()).runId);
    expect(runs()).toBe(1);
  });

  it("runs once when the same key arrives while the first request is still running", async () => {
    const { app, runs } = counted();
    const [a, b] = await Promise.all([post(app, "c", {}, "k"), post(app, "c", {}, "k")]);
    expect((await a.json()).runId).toBe((await b.json()).runId);
    expect(runs()).toBe(1);
  });

  it("rejects the same key with a different input, and separates keys per flow", async () => {
    const { app, runs } = counted();
    await post(app, "c", { n: 1 }, "k");
    expect((await post(app, "c", { n: 2 }, "k")).status).toBe(422);
    expect((await post(app, "f", { n: 1 }, "k")).status).toBe(200); // same key, other flow
    expect(runs()).toBe(1);
  });

  it("does not keep failed runs, so a retry runs again", async () => {
    const { app } = counted();
    const first = await (await post(app, "f", {}, "k")).json();
    const second = await post(app, "f", {}, "k");
    expect(first.ok).toBe(false);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    expect((await second.json()).runId).not.toBe(first.runId);
  });

  it("does nothing without a key", async () => {
    const { app, runs } = counted();
    await post(app, "c", {});
    await post(app, "c", {});
    expect(runs()).toBe(2);
  });
});

describe("openapi spec", () => {
  it("documents exactly the routes the app serves", () => {
    const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)).sort();
    const engine = createEngine({ registry: defaultRegistry() });
    if (!engine.ok) throw new Error(engine.error);
    const served = createApp({ engine: engine.value, log: () => {} }).routes
      .filter((r) => r.method !== "ALL" && !r.path.includes("*"))
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`);
    // A route with route-level middleware is listed once per handler.
    expect(documented).toEqual([...new Set(served)].sort());
  });
});

describe("input schema", () => {
  const flow = { id: "greet", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, nodes: [{ id: "out", type: "output" }], edges: [] };
  const engine = createEngine({ registry: defaultRegistry(), flows: [flow] });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, log: () => {} });
  const post = (input: object) => app.request("/v1/flows/greet/run", { method: "POST", body: JSON.stringify({ input }) });

  it("answers 400 for input that breaks the flow's schema", async () => {
    const res = await post({ name: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("name");
    expect((await post({ name: "Ann" })).status).toBe(200);
  });
});

describe("per-flow openapi", () => {
  const flows = [
    { id: "classify-error", description: "Classify an error.", input: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, nodes: [{ id: "out", type: "output" }], edges: [] },
    { id: "plain", nodes: [{ id: "out", type: "output" }], edges: [] },
  ];
  const engine = createEngine({ registry: defaultRegistry(), flows });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, tokens: ["t"], log: () => {} });
  const get = async () => (await (await app.request("/openapi.json", { headers: { authorization: "Bearer t" } })).json()) as any;

  it("needs the bearer token", async () => {
    expect((await app.request("/openapi.json")).status).toBe(401);
  });

  it("has one typed operation for every served flow", async () => {
    const spec = await get();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v1/flows/{id}/run"]).toBeUndefined();
    const ops = engine.value.flows().map((f) => spec.paths[`/v1/flows/${f.id}/run`]?.post);
    expect(ops.every(Boolean)).toBe(true); // fails when a served flow is missing
    expect(ops.map((o) => o.operationId)).toEqual(["runClassifyError", "runPlain"]);
    expect(ops[0].summary).toBe("Classify an error.");
    expect(spec.components.schemas.ClassifyErrorInput.required).toEqual(["message"]);
    expect(ops[0].requestBody.required).toBe(true);
    expect(ops[1].requestBody.required).toBe(false);
  });

  it("rejects flow ids that would share an operation name", () => {
    expect(() => buildOpenApi([{ id: "a-b", nodes: 1 }, { id: "a_b", nodes: 1 }])).toThrow(/same operation name/);
  });
});
