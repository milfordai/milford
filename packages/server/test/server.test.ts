import { createChannels } from "@milfordai/channels";
import { createEngine, defaultRegistry, type Provider } from "@milfordai/core";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildOpenApi } from "../src/openapi.js";
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
const read = (path: string) => {
  if (path.endsWith("hello.json")) return flowJson;
  throw new Error("ENOENT");
};

describe("server", () => {
  const fake: Provider = { id: "m", type: "fake", capabilities: [] };
  const config = parseConfig(yaml, "/cfg", { KEY: "k", TOKEN: "secret" }, read);
  if (!config.ok) throw new Error(config.error);
  const engine = createEngine({ registry: defaultRegistry().registerProvider("fake", () => ({ ok: true, value: fake })), providers: config.value.providers, flows: config.value.flows });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, tokens: ["secret"], log: () => {}, maxBodyBytes: 200 });
  const auth = { authorization: "Bearer secret" };
  const post = (flowId: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/v1/flows/${flowId}/run`, { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });

  it("serves /health without auth and guards /v1", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/v1/flows")).status).toBe(401);
    expect((await app.request("/v1/flows", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect(await (await app.request("/v1/flows", { headers: auth })).json()).toEqual({ flows: [{ id: "hello", nodes: 2 }] });
  });

  it("runs a flow", async () => {
    const response = await post("hello", { input: { name: "Ann" } });
    expect(response.status).toBe(200);
    expect((await response.json()).output.output).toBe("Hello Ann");
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
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = createEngine({
      registry: defaultRegistry().registerNode("slow", { run: async () => (await gate, { success: true }) }),
      flows: [{ id: "s", nodes: [{ id: "a", type: "slow" }], edges: [] }],
      maxConcurrentRuns: 1,
    });
    if (!slow.ok) throw new Error(slow.error);
    const app = createApp({ engine: slow.value, log: () => {} });
    const first = app.request("/v1/flows/s/run", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await app.request("/v1/flows/s/run", { method: "POST", body: "{}" });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
  });

  it("logs one JSON line per run", async () => {
    const lines: string[] = [];
    const app = createApp({ engine: engine.value, log: (line) => lines.push(line) });
    await app.request("/v1/flows/hello/run", { method: "POST", body: JSON.stringify({ input: { name: "Ann" } }) });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "run", flow: "hello", ok: true });
  });

  it("streams events over SSE, ending with the result", async () => {
    const response = await post("hello", { input: { name: "Ann" } }, { accept: "text/event-stream" });
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect([...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1])).toEqual(["node:start", "node:done", "node:start", "node:done", "result"]);
  });
});

describe("webhook channels", () => {
  const secret = "0123456789abcdef";
  const engine = createEngine({ registry: defaultRegistry(), flows: [JSON.parse(flowJson)] });
  if (!engine.ok) throw new Error(engine.error);
  const channels = createChannels([{ id: "w", type: "webhook", flow: "hello", secret }], { engine: engine.value, log: () => {} });
  if (!channels.ok) throw new Error(channels.error);
  const app = createApp({ engine: engine.value, tokens: ["bearer"], channels: channels.value, log: () => {} });
  const signed = (body: string, key = secret) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { "x-milford-timestamp": ts, "x-milford-signature": `sha256=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}` };
  };

  it("accepts a signed request without a bearer token, and rejects a bad one", async () => {
    const body = JSON.stringify({ name: "Ann" });
    const response = await app.request("/hooks/w", { method: "POST", body, headers: signed(body) });
    expect(response.status).toBe(200);
    expect((await response.json()).output).toBe("Hello Ann");
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
    const [first, second] = await Promise.all([post(app, "c", {}, "k"), post(app, "c", {}, "k")]);
    expect((await first.json()).runId).toBe((await second.json()).runId);
    expect(runs()).toBe(1);
  });

  it("rejects the same key with a different input, and separates keys per flow", async () => {
    const { app, runs } = counted();
    await post(app, "c", { n: 1 }, "k");
    expect((await post(app, "c", { n: 2 }, "k")).status).toBe(422);
    expect((await post(app, "f", { n: 1 }, "k")).status).toBe(200); // same key, other flow
    expect(runs()).toBe(1);
  });

  it("gives two callers each their own key namespace", async () => {
    let calls = 0;
    const engine = createEngine({ registry: defaultRegistry().registerNode("count", { run: async () => ({ success: true, output: String(++calls) }) }), flows: [{ id: "c", nodes: [{ id: "a", type: "count" }], edges: [] }] });
    if (!engine.ok) throw new Error(engine.error);
    const app = createApp({ engine: engine.value, tokens: ["ann", "bob"], log: () => {} });
    const send = (token: string) => app.request("/v1/flows/c/run", { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": "same-key" }, body: JSON.stringify({ input: {} }) });
    const ann = await send("ann");
    const bob = await send("bob");
    expect(ann.headers.get("idempotent-replayed")).toBeNull();
    expect(bob.headers.get("idempotent-replayed")).toBeNull(); // Bob's key is not Ann's
    expect((await ann.json()).runId).not.toBe((await bob.json()).runId);
    expect(calls).toBe(2);
    expect((await send("ann")).headers.get("idempotent-replayed")).toBe("true"); // but each caller still replays its own
    expect(calls).toBe(2);
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
    const documented = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)).sort();
    const engine = createEngine({ registry: defaultRegistry() });
    if (!engine.ok) throw new Error(engine.error);
    const served = createApp({ engine: engine.value, log: () => {} }).routes
      .filter((route) => route.method !== "ALL" && !route.path.includes("*"))
      .map((route) => `${route.method} ${route.path.replace(/:(\w+)/g, "{$1}")}`);
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
    const response = await post({ name: 1 });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("name");
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
    const ops = engine.value.flows().map((flow) => spec.paths[`/v1/flows/${flow.id}/run`]?.post);
    expect(ops.every(Boolean)).toBe(true); // fails when a served flow is missing
    expect(ops.map((operation) => operation.operationId)).toEqual(["runClassifyError", "runPlain"]);
    expect(ops[0].summary).toBe("Classify an error.");
    expect(spec.components.schemas.ClassifyErrorInput.required).toEqual(["message"]);
    expect(ops[0].requestBody.required).toBe(true);
    expect(ops[1].requestBody.required).toBe(false);
  });

  it("rejects flow ids that would share an operation name", () => {
    expect(() => buildOpenApi([{ id: "a-b", nodes: 1 }, { id: "a_b", nodes: 1 }])).toThrow(/same operation name/);
  });
});

describe("request timeout override", () => {
  // A node that answers "aborted" when its signal fires, or "done" after 300 ms, so the override is
  // observable without timing flakiness: the engine default (1 ms) fires the abort way before 300 ms.
  const waitNode = async (ctx: { signal: AbortSignal }) =>
    new Promise<{ success: boolean; output?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ success: true, output: "done" }), 300);
      ctx.signal.addEventListener("abort", () => { clearTimeout(timer); resolve({ success: false, error: "aborted" }); }, { once: true });
    });
  const engine = createEngine({
    registry: defaultRegistry().registerNode("wait", { run: waitNode }),
    flows: [{ id: "slow", nodes: [{ id: "a", type: "wait" }], edges: [] }],
    timeoutMs: 1,
  });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, log: () => {} });
  const post = (headers: Record<string, string> = {}) => app.request("/v1/flows/slow/run", { method: "POST", headers, body: "{}" });

  it("binds a run to the engine default without the header, and lets the header extend it", async () => {
    const short = await post();
    expect(short.status).toBe(200);
    expect(((await short.json()) as { nodes: { a: { status: string; result?: { error?: string } } } }).nodes.a.result?.error).toBe("aborted");
    const long = await post({ "x-milford-timeout-ms": "50000" });
    expect(long.status).toBe(200);
    expect(((await long.json()) as { nodes: { a: { status: string; result?: { output?: string } } } }).nodes.a).toMatchObject({ status: "done", result: { output: "done" } });
  });

  it("applies the override to an event stream", async () => {
    const response = await app.request("/v1/flows/slow/run", { method: "POST", headers: { accept: "text/event-stream", "x-milford-timeout-ms": "50000" }, body: "{}" });
    const text = await response.text();
    expect(text).toContain('"output":"done"');
  });

  it("rejects malformed and oversized timeout headers with 400", async () => {
    for (const bad of ["abc", "0", "-5", "200.5", "600001"]) {
      const response = await post({ "x-milford-timeout-ms": bad });
      expect(response.status, bad).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("X-Milford-Timeout-Ms");
    }
  });
});

describe("flow cache over HTTP", () => {
  let calls = 0;
  const registry = defaultRegistry().registerNode("count", { run: async () => (calls++, { success: true, output: `run ${calls}` }) });
  const flow = { id: "c", cache: { mode: "direct" as const, ttlMs: 60_000 }, nodes: [{ id: "n", type: "count" }, { id: "out", type: "output" }], edges: [{ from: "n", to: "out" }] };
  const engine = createEngine({ registry, flows: [flow] });
  if (!engine.ok) throw new Error(engine.error);
  const lines: string[] = [];
  const app = createApp({ engine: engine.value, log: (line) => lines.push(line) });
  const post = async (input: object, headers: Record<string, string> = {}) => (await (await app.request("/v1/flows/c/run", { method: "POST", headers, body: JSON.stringify({ input }) })).json()) as { cache?: string; runId: string };

  it("answers a repeated request from the cache, and shows hit or miss in the body and the log", async () => {
    const first = await post({ q: 1 });
    const second = await post({ q: 1 });
    expect([first.cache, second.cache]).toEqual(["miss", "hit"]);
    expect(second.runId).toBe(first.runId);
    expect(calls).toBe(1);
    expect(lines.map((line) => JSON.parse(line).cache)).toEqual(["miss", "hit"]);
  });

  it("honours Cache-Control: no-cache and no-store", async () => {
    await post({ q: 2 });
    const before = calls;
    expect((await post({ q: 2 }, { "cache-control": "no-cache" })).cache).toBe("miss");
    expect(calls).toBe(before + 1);
    expect((await post({ q: 2 })).cache).toBe("hit"); // no-cache refreshed the entry
    await post({ q: 3 }, { "cache-control": "no-store" });
    expect((await post({ q: 3 })).cache).toBe("miss"); // no-store stored nothing
  });

  it("lists the cache field and header in the OpenAPI spec", () => {
    const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as any;
    expect(spec.components.schemas.RunResult.properties.cache.enum).toEqual(["hit", "miss"]);
    expect(spec.paths["/v1/flows/{id}/run"].post.parameters.map((parameter: { name: string }) => parameter.name)).toContain("Cache-Control");
  });
});

describe("run history", () => {
  const flow = { id: "greet", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, cache: { mode: "direct" as const, ttlMs: 60_000 }, nodes: [{ id: "hi", type: "prompt", config: { template: "Hello {{input.name}}!" } }, { id: "out", type: "output" }], edges: [{ from: "hi", to: "out" }] };
  const make = (recordRuns?: "trace" | "full") => {
    const engine = createEngine({ registry: defaultRegistry(), flows: [flow] });
    if (!engine.ok) throw new Error(engine.error);
    return createApp({ engine: engine.value, log: () => {}, recordRuns });
  };
  const run = async (app: ReturnType<typeof make>, input: object, path = "/v1/flows/greet/run", headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers, body: JSON.stringify({ input }) });
  const list = async (app: ReturnType<typeof make>, query = "") => ((await (await app.request(`/v1/runs${query}`)).json()) as { runs: { runId: string; flow: string; ok: boolean; nodes: number }[] }).runs;

  it("lists runs newest first and returns one trace, without inputs or outputs by default", async () => {
    const app = make();
    const first = (await (await run(app, { name: "Ann" })).json()) as { runId: string };
    const second = (await (await run(app, { name: "Bo" })).json()) as { runId: string };
    expect((await list(app)).map((entry) => entry.runId)).toEqual([second.runId, first.runId]);
    expect(await list(app, "?flow=nope")).toEqual([]);
    const response = await app.request(`/v1/runs/${first.runId}`);
    const body = await response.json();
    expect(body).toMatchObject({ runId: first.runId, flow: "greet", ok: true });
    expect(JSON.stringify(body)).not.toContain("Ann");
    expect((await app.request("/v1/runs/nope")).status).toBe(404);
  });

  it("lists and reads only the caller's own runs when the server has auth on", async () => {
    const engine = createEngine({ registry: defaultRegistry(), flows: [flow] });
    if (!engine.ok) throw new Error(engine.error);
    const app = createApp({ engine: engine.value, tokens: ["ann", "bob"], log: () => {} });
    const runAs = (token: string, name: string) => app.request("/v1/flows/greet/run", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ input: { name } }) });
    const listAs = async (token: string) => ((await (await app.request("/v1/runs", { headers: { authorization: `Bearer ${token}` } })).json()) as { runs: { runId: string }[] }).runs;
    const anns = (await (await runAs("ann", "Ann")).json()) as { runId: string };
    await runAs("bob", "Bo");
    expect((await listAs("bob")).map((entry) => entry.runId)).not.toContain(anns.runId); // Bob cannot list Ann's run
    expect((await listAs("ann")).map((entry) => entry.runId)).toEqual([anns.runId]);
    expect((await app.request(`/v1/runs/${anns.runId}`, { headers: { authorization: "Bearer bob" } })).status).toBe(404); // nor read it by id
  });

  it("keeps inputs and results with record: full", async () => {
    const app = make("full");
    const first = (await (await run(app, { name: "Ann" })).json()) as { runId: string };
    const body = (await (await app.request(`/v1/runs/${first.runId}`)).json()) as { input: unknown; output: { output: string } };
    expect(body.input).toEqual({ name: "Ann" });
    expect(body.output.output).toBe("Hello Ann!");
  });

  it("saves streamed runs, and skips cache hits and rejected input", async () => {
    const app = make();
    await (await run(app, { name: "Cy" }, "/v1/flows/greet/run", { accept: "text/event-stream" })).text(); // read to the end: the run finishes with the stream
    expect(await list(app)).toHaveLength(1);
    await run(app, { name: "Di" });
    await run(app, { name: "Di" }); // a cache hit: not a new run
    await run(app, { name: 1 }); // invalid input: nothing ran
    expect(await list(app)).toHaveLength(2);
  });

  it("is documented", () => {
    const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/runs", "/v1/runs/{id}"]));
  });
});

describe("openai-compatible chat completions", () => {
  // A chat provider that echoes the prompt, and a chat flow that runs it through an `llm` node.
  const provider: Provider = {
    id: "m",
    type: "fake",
    capabilities: ["chat"],
    chat: async ({ prompt }) => ({ ok: true, value: { text: `echo: ${prompt}` } }),
  };
  const chatFlow = { id: "chat", nodes: [{ id: "p", type: "llm", config: { provider: "m", prompt: "{{input.prompt}}" } }, { id: "out", type: "output" }], edges: [{ from: "p", to: "out" }] };
  const failingFlow = { id: "fails", nodes: [{ id: "f", type: "prompt", config: { template: "{{input.missing}}" } }, { id: "out", type: "output" }], edges: [{ from: "f", to: "out" }] };
  const engine = createEngine({
    registry: defaultRegistry().registerProvider("fake", () => ({ ok: true, value: provider })),
    providers: [{ id: "m", type: "fake" }],
    flows: [chatFlow, failingFlow],
  });
  if (!engine.ok) throw new Error(engine.error);
  const app = createApp({ engine: engine.value, tokens: ["secret"], log: () => {} });
  const auth = { authorization: "Bearer secret" };
  const chat = (body: unknown, headers: Record<string, string> = {}) => app.request("/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });

  it("runs a flow for a chat request and returns an OpenAI-shaped completion", async () => {
    const response = await chat({ model: "chat", messages: [{ role: "user", content: "Hi there" }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("chat");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices).toEqual([{ index: 0, message: { role: "assistant", content: "echo: Hi there" }, finish_reason: "stop" }]);
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    // The run is saved to history, named after the flow.
    const runs = (await (await app.request("/v1/runs", { headers: auth })).json()) as { runs: { flow: string }[] };
    expect(runs.runs[0]).toMatchObject({ flow: "chat" });
  });

  it("uses the last user message as input.prompt and ignores extra OpenAI fields", async () => {
    const response = await chat({ model: "chat", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "A" }, { role: "assistant", content: "ok" }, { role: "user", content: "B" }], temperature: 0.5, max_tokens: 10 });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).choices[0].message.content).toBe("echo: B");
  });

  it("streams OpenAI-style SSE chunks ending in [DONE]", async () => {
    const response = await chat({ model: "chat", messages: [{ role: "user", content: "Stream me" }], stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.startsWith("data: "));
    const data = lines.map((line) => line.slice(6));
    expect(data.at(-1)).toBe("[DONE]");
    const chunks = data.slice(0, -1).map((item) => JSON.parse(item)) as any[];
    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk" && chunk.model === "chat")).toBe(true);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.map((chunk) => chunk.choices[0].delta.content).filter((content) => content !== undefined).join("")).toBe("echo: Stream me");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("returns 400 for malformed bodies and invalid messages", async () => {
    expect((await app.request("/v1/chat/completions", { method: "POST", headers: auth, body: "{" })).status).toBe(400);
    expect((await chat({})).status).toBe(400); // model missing
    expect((await chat({ model: "chat" })).status).toBe(400); // messages missing
    expect((await chat({ model: "chat", messages: [{ role: "user" }] })).status).toBe(400); // content missing
    expect((await chat({ model: "chat", messages: [], stream: "yes" })).status).toBe(400); // stream not boolean
  });

  it("returns 404 for an unknown model and 401 without a token", async () => {
    const notFound = await chat({ model: "nope", messages: [] });
    expect(notFound.status).toBe(404);
    expect((await notFound.json())).toMatchObject({ error: { message: expect.stringContaining("nope") } });
    expect((await app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "chat", messages: [] }) })).status).toBe(401);
  });

  it("returns 500 with the failing node's error when the flow fails", async () => {
    const response = await chat({ model: "fails", messages: [{ role: "user", content: "x" }] });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toContain("missing");
  });

  it("documents the route in the OpenAPI spec", () => {
    const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8")) as any;
    expect(spec.paths["/v1/chat/completions"].post.operationId).toBe("chatCompletions");
  });
});
