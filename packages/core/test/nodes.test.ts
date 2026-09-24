import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, flow, render, type DecideRequest, type Decision, type Provider, type Result } from "../src/index.js";

const fakeDecider = (id: string, answer: (request: DecideRequest) => Decision, batch?: (count: number) => void): Provider => ({
  id,
  type: "fake",
  capabilities: ["decide", "chat"],
  chat: async (request) => ({ ok: true, value: { text: `echo:${request.prompt}` } }),
  decide: async (request) => ({ ok: true, value: answer(request) }),
  ...(batch && {
    decideMany: async (requests: DecideRequest[]): Promise<Result<Decision[]>> => {
      batch(requests.length);
      return { ok: true, value: requests.map(answer) };
    },
  }),
});

const engineWith = (providers: Provider[], flows: ReturnType<typeof flow>[], fetch?: typeof globalThis.fetch) => {
  const registry = defaultRegistry().registerProvider("fake", (config) => ({ ok: true, value: providers.find((provider) => provider.id === config.id)! }));
  const engine = createEngine({ registry, providers: providers.map((provider) => ({ id: provider.id, type: "fake" })), flows: flows.map((flow) => flow.build()), fetch });
  if (!engine.ok) throw new Error(engine.error);
  return engine.value;
};

describe("templates", () => {
  it("fills variables and errors on unknown ones", () => {
    expect(render("hi {{input.name}} {{a}} {{a.data.x}}", { input: { name: "Ann" }, a: { success: true, output: "out", data: { x: 1 } } })).toEqual({ ok: true, value: "hi Ann out " + "1" });
    expect(render("{{nope}}", {}).ok).toBe(false);
  });
  it("treats prototype steps as unknown variables, but keeps ordinary reads working", () => {
    expect(render("{{input.constructor}}", { input: { a: 1 } }).ok).toBe(false); // never read the prototype chain
    expect(render("{{input.__proto__.polluted}}", { input: { a: 1 } }).ok).toBe(false);
    expect(render("{{input.name.length}}", { input: { name: "Ann" } })).toEqual({ ok: true, value: "3" }); // a string's length still resolves
  });
});

describe("built-in nodes", () => {
  it("input -> prompt -> output", async () => {
    const engine = engineWith([], [flow("f").node("in", "input").node("p", "prompt", { template: "Hello {{input.name}}" }).node("out", "output").edge("in", "p").edge("p", "out")]);
    const result = await engine.run("f", { name: "Ann" });
    expect(result.ok && result.value.output?.output).toBe("Hello Ann");
  });

  it("llm node calls the provider, applies presets and truncation", async () => {
    const engine = engineWith([fakeDecider("m", () => ({ kind: "noul" }))], [flow("f").node("p", "prompt", { template: "abcdef" }).node("l", "llm", { provider: "m", maxInputChars: 3 }).node("out", "output").edge("p", "l").edge("l", "out")]);
    const result = await engine.run("f");
    expect(result.ok && result.value.output?.output).toBe("echo:abc");
  });

  it("http node renders the request and returns status and body", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const engine = engineWith([], [flow("f").node("h", "http", { url: "http://x/{{input.dev}}", allow: ["http://x"], method: "POST", body: { power: "{{input.p}}" } }).node("out", "output").edge("h", "out")], fetch);
    const result = await engine.run("f", { dev: "lamp", p: "on" });
    expect(seen?.url).toBe("http://x/lamp");
    expect(seen?.init?.body).toBe('{"power":"on"}');
    expect(result.ok && result.value.output?.data).toEqual({ status: 200, body: { ok: true } });
  });

  it("requires an allow list for a templated url, and refuses an origin outside it", async () => {
    const attempts: string[] = [];
    const fetch = (async (url: string) => (attempts.push(url), new Response("ok"))) as unknown as typeof globalThis.fetch;
    const withoutAllow = createEngine({ registry: defaultRegistry(), flows: [flow("f").node("h", "http", { url: "http://{{input.host}}/x" }).build()] });
    expect(!withoutAllow.ok && withoutAllow.error).toMatch(/allow list/); // rejected at load time, before any run

    const engine = engineWith([], [flow("f").node("h", "http", { url: "http://{{input.host}}/x", allow: ["http://safe.example"] }).node("out", "output").edge("h", "out")], fetch);
    const blocked = await engine.run("f", { host: "169.254.169.254" });
    expect(attempts).toEqual([]); // never fetched
    expect(blocked.ok && blocked.value.nodes.h?.result?.error).toMatch(/not in the allow list/);
    const allowed = await engine.run("f", { host: "safe.example" });
    expect(allowed.ok && allowed.value.ok).toBe(true);
    expect(attempts).toEqual(["http://safe.example/x"]);
  });

  it("http node reports non-2xx as a failed node", async () => {
    const fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const engine = engineWith([], [flow("f").node("h", "http", { url: "http://x" })], fetch);
    const result = await engine.run("f");
    expect(result.ok && result.value.ok).toBe(false);
  });

  it("http node retries a 5xx (infrastructure) under the default retry policy, but not a 4xx", async () => {
    let fivexx = 0;
    const flaky = (async () => (++fivexx < 3 ? new Response("nope", { status: 500 }) : new Response("ok", { status: 200 }))) as unknown as typeof globalThis.fetch;
    const engine5 = engineWith([], [flow("f").node("h", "http", { url: "http://x" }, { retry: { attempts: 3, backoffMs: 1 } }).node("out", "output").edge("h", "out")], flaky);
    const result5 = await engine5.run("f");
    expect(result5.ok && result5.value.ok).toBe(true);
    expect(fivexx).toBe(3);

    let fourxx = 0;
    const bad = (async () => { fourxx++; return new Response("nope", { status: 400 }); }) as unknown as typeof globalThis.fetch;
    const engine4 = engineWith([], [flow("f").node("h", "http", { url: "http://x" }, { retry: { attempts: 3, backoffMs: 1 } })], bad);
    const result4 = await engine4.run("f");
    expect(result4.ok && result4.value.ok).toBe(false);
    expect(fourxx).toBe(1);
  });

  it("retries 429 and 408 like infrastructure, but still not other 4xx", async () => {
    for (const status of [429, 408, 404]) {
      let calls = 0;
      const always = (async () => { calls++; return new Response("nope", { status }); }) as unknown as typeof globalThis.fetch;
      const engine = engineWith([], [flow("f").node("h", "http", { url: "http://x" }, { retry: { attempts: 3, backoffMs: 1 } })], always);
      await engine.run("f");
      expect(calls, `HTTP ${status}`).toBe(status === 404 ? 1 : 3);
    }
  });

  it("fails a response body over maxResponseBytes instead of buffering it", async () => {
    const fetch = (async () => new Response("x".repeat(100))) as unknown as typeof globalThis.fetch;
    const engine = engineWith([], [flow("f").node("h", "http", { url: "http://x", maxResponseBytes: 10 })], fetch);
    const result = await engine.run("f");
    expect(result.ok && result.value.ok).toBe(false);
    expect(result.ok && result.value.nodes.h?.result?.error).toMatch(/maxResponseBytes/);
  });

  it("fails a header value that would splice new headers, before any request", async () => {
    let attempted = false;
    const fetch = (async () => (attempted = true, new Response("ok"))) as unknown as typeof globalThis.fetch;
    const engine = engineWith([], [flow("f").node("h", "http", { url: "http://x", headers: { "x-user": "{{input.user}}" } })], fetch);
    const result = await engine.run("f", { user: "alice\r\nx-admin: true" });
    expect(attempted).toBe(false); // never fetched
    expect(result.ok && result.value.nodes.h?.result?.error).toMatch(/header "x-user"/);
  });
});

describe("decision node", () => {
  const choose = (request: DecideRequest): Decision => ({ kind: "choice", choice: request.options![0]!, confidence: 0.4, probabilities: { [request.options![0]!]: 0.4 } });

  it("gates low-confidence choices to none_of_these and branches on it", async () => {
    const engine = engineWith([fakeDecider("j", choose)], [
      flow("f")
        .node("d", "decision", { provider: "j", kind: "choice", prompt: "which?", options: ["a", "b"], minConfidence: 0.5 })
        .node("act", "prompt", { template: "act" })
        .node("noop", "prompt", { template: "noop" })
        .edge("d", "act", { path: "data.choice", op: "neq", value: "none_of_these" })
        .edge("d", "noop", { path: "data.choice", op: "eq", value: "none_of_these" }),
    ]);
    const result = await engine.run("f");
    if (!result.ok) throw new Error(result.error);
    expect(result.value.nodes.d?.result?.output).toBe("none_of_these");
    expect(result.value.nodes.act?.status).toBe("skipped");
    expect(result.value.nodes.noop?.status).toBe("done");
  });

  it("takes dynamic options from the run input", async () => {
    let received: string[] | undefined;
    const engine = engineWith([fakeDecider("j", (request) => ((received = request.options), { kind: "choice", choice: "lamp", confidence: 0.9 }))], [
      flow("f").node("d", "decision", { provider: "j", kind: "choice", prompt: "device?", options: "{{input.devices}}" }),
    ]);
    await engine.run("f", { devices: ["lamp", "fan"] });
    expect(received).toEqual(["lamp", "fan", "none_of_these"]);
  });

  it("batches same-level decisions through decideMany when available", async () => {
    const sizes: number[] = [];
    const engine = engineWith([fakeDecider("j", choose, (count) => sizes.push(count))], [
      flow("f").node("a", "decision", { provider: "j", kind: "choice", prompt: "q", options: ["x"] }).node("b", "decision", { provider: "j", kind: "choice", prompt: "q", options: ["y"] }),
    ]);
    const result = await engine.run("f");
    expect(result.ok && result.value.ok).toBe(true);
    expect(sizes).toEqual([2]);
  });

  it("rejects a decision on a provider that cannot decide, at load time", () => {
    const chatOnly: Provider = { id: "c", type: "fake", capabilities: ["chat"], chat: async () => ({ ok: true, value: { text: "" } }) };
    const registry = defaultRegistry().registerProvider("fake", () => ({ ok: true, value: chatOnly }));
    const engine = createEngine({ registry, providers: [{ id: "c", type: "fake" }], flows: [flow("f").node("d", "decision", { provider: "c", kind: "noul", prompt: "q" }).build()] });
    expect(engine).toEqual({ ok: false, error: 'flow "f": node "d": provider "c" cannot decide' });
  });

  it("falls back to the next provider when the first fails", async () => {
    const bad: Provider = { id: "bad", type: "fake", capabilities: ["decide"], decide: async () => ({ ok: false, error: "down" }) };
    const good = fakeDecider("good", () => ({ kind: "noul", noul: 0.9 }));
    const registry = defaultRegistry().registerProvider("fake", (config) => ({ ok: true, value: config.id === "bad" ? bad : good }));
    const engine = createEngine({ registry, providers: [{ id: "bad", type: "fake", fallback: ["good"] }, { id: "good", type: "fake" }], flows: [flow("f").node("d", "decision", { provider: "bad", kind: "noul", prompt: "q" }).build()] });
    if (!engine.ok) throw new Error(engine.error);
    const result = await engine.value.run("f");
    expect(result.ok && result.value.nodes.d?.result?.output).toBe("0.9");
  });
});
