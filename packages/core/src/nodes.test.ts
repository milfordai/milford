import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, flow, render, type DecideRequest, type Decision, type Provider, type Result } from "./index.js";

const fakeDecider = (id: string, answer: (r: DecideRequest) => Decision, batch?: (n: number) => void): Provider => ({
  id,
  type: "fake",
  capabilities: ["decide", "chat"],
  chat: async (r) => ({ ok: true, value: { text: `echo:${r.prompt}` } }),
  decide: async (r) => ({ ok: true, value: answer(r) }),
  ...(batch && {
    decideMany: async (rs: DecideRequest[]): Promise<Result<Decision[]>> => {
      batch(rs.length);
      return { ok: true, value: rs.map(answer) };
    },
  }),
});

const engineWith = (providers: Provider[], flows: ReturnType<typeof flow>[], fetch?: typeof globalThis.fetch) => {
  const registry = defaultRegistry().registerProvider("fake", (c) => ({ ok: true, value: providers.find((p) => p.id === c.id)! }));
  const e = createEngine({ registry, providers: providers.map((p) => ({ id: p.id, type: "fake" })), flows: flows.map((f) => f.build()), fetch });
  if (!e.ok) throw new Error(e.error);
  return e.value;
};

describe("templates", () => {
  it("fills variables and errors on unknown ones", () => {
    expect(render("hi {{input.name}} {{a}} {{a.data.x}}", { input: { name: "Ann" }, a: { success: true, output: "out", data: { x: 1 } } })).toEqual({ ok: true, value: "hi Ann out " + "1" });
    expect(render("{{nope}}", {}).ok).toBe(false);
  });
});

describe("built-in nodes", () => {
  it("input -> prompt -> output", async () => {
    const e = engineWith([], [flow("f").node("in", "input").node("p", "prompt", { template: "Hello {{input.name}}" }).node("out", "output").edge("in", "p").edge("p", "out")]);
    const r = await e.run("f", { name: "Ann" });
    expect(r.ok && r.value.output?.output).toBe("Hello Ann");
  });

  it("llm node calls the provider, applies presets and truncation", async () => {
    const e = engineWith([fakeDecider("m", () => ({ kind: "noul" }))], [flow("f").node("p", "prompt", { template: "abcdef" }).node("l", "llm", { provider: "m", maxInputChars: 3 }).node("out", "output").edge("p", "l").edge("l", "out")]);
    const r = await e.run("f");
    expect(r.ok && r.value.output?.output).toBe("echo:abc");
  });

  it("http node renders the request and returns status and body", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const e = engineWith([], [flow("f").node("h", "http", { url: "http://x/{{input.dev}}", method: "POST", body: { power: "{{input.p}}" } }).node("out", "output").edge("h", "out")], fetch);
    const r = await e.run("f", { dev: "lamp", p: "on" });
    expect(seen?.url).toBe("http://x/lamp");
    expect(seen?.init?.body).toBe('{"power":"on"}');
    expect(r.ok && r.value.output?.data).toEqual({ status: 200, body: { ok: true } });
  });

  it("http node reports non-2xx as a failed node", async () => {
    const fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const e = engineWith([], [flow("f").node("h", "http", { url: "http://x" })], fetch);
    const r = await e.run("f");
    expect(r.ok && r.value.ok).toBe(false);
  });

  it("http node retries a 5xx (infrastructure) under the default retry policy, but not a 4xx", async () => {
    let fivexx = 0;
    const flaky = (async () => (++fivexx < 3 ? new Response("nope", { status: 500 }) : new Response("ok", { status: 200 }))) as unknown as typeof globalThis.fetch;
    const e5 = engineWith([], [flow("f").node("h", "http", { url: "http://x" }, { retry: { attempts: 3, backoffMs: 1 } }).node("out", "output").edge("h", "out")], flaky);
    const r5 = await e5.run("f");
    expect(r5.ok && r5.value.ok).toBe(true);
    expect(fivexx).toBe(3);

    let fourxx = 0;
    const bad = (async () => { fourxx++; return new Response("nope", { status: 400 }); }) as unknown as typeof globalThis.fetch;
    const e4 = engineWith([], [flow("f").node("h", "http", { url: "http://x" }, { retry: { attempts: 3, backoffMs: 1 } })], bad);
    const r4 = await e4.run("f");
    expect(r4.ok && r4.value.ok).toBe(false);
    expect(fourxx).toBe(1);
  });
});

describe("decision node", () => {
  const choose = (r: DecideRequest): Decision => ({ kind: "choice", choice: r.options![0]!, confidence: 0.4, probabilities: { [r.options![0]!]: 0.4 } });

  it("gates low-confidence choices to none_of_these and branches on it", async () => {
    const e = engineWith([fakeDecider("j", choose)], [
      flow("f")
        .node("d", "decision", { provider: "j", kind: "choice", prompt: "which?", options: ["a", "b"], minConfidence: 0.5 })
        .node("act", "prompt", { template: "act" })
        .node("noop", "prompt", { template: "noop" })
        .edge("d", "act", { path: "data.choice", op: "neq", value: "none_of_these" })
        .edge("d", "noop", { path: "data.choice", op: "eq", value: "none_of_these" }),
    ]);
    const r = await e.run("f");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.nodes.d?.result?.output).toBe("none_of_these");
    expect(r.value.nodes.act?.status).toBe("skipped");
    expect(r.value.nodes.noop?.status).toBe("done");
  });

  it("takes dynamic options from the run input", async () => {
    let got: string[] | undefined;
    const e = engineWith([fakeDecider("j", (r) => ((got = r.options), { kind: "choice", choice: "lamp", confidence: 0.9 }))], [
      flow("f").node("d", "decision", { provider: "j", kind: "choice", prompt: "device?", options: "{{input.devices}}" }),
    ]);
    await e.run("f", { devices: ["lamp", "fan"] });
    expect(got).toEqual(["lamp", "fan", "none_of_these"]);
  });

  it("batches same-level decisions through decideMany when available", async () => {
    const sizes: number[] = [];
    const e = engineWith([fakeDecider("j", choose, (n) => sizes.push(n))], [
      flow("f").node("a", "decision", { provider: "j", kind: "choice", prompt: "q", options: ["x"] }).node("b", "decision", { provider: "j", kind: "choice", prompt: "q", options: ["y"] }),
    ]);
    const r = await e.run("f");
    expect(r.ok && r.value.ok).toBe(true);
    expect(sizes).toEqual([2]);
  });

  it("rejects a decision on a provider that cannot decide, at load time", () => {
    const chatOnly: Provider = { id: "c", type: "fake", capabilities: ["chat"], chat: async () => ({ ok: true, value: { text: "" } }) };
    const registry = defaultRegistry().registerProvider("fake", () => ({ ok: true, value: chatOnly }));
    const e = createEngine({ registry, providers: [{ id: "c", type: "fake" }], flows: [flow("f").node("d", "decision", { provider: "c", kind: "noul", prompt: "q" }).build()] });
    expect(e).toEqual({ ok: false, error: 'flow "f": node "d": provider "c" cannot decide' });
  });

  it("falls back to the next provider when the first fails", async () => {
    const bad: Provider = { id: "bad", type: "fake", capabilities: ["decide"], decide: async () => ({ ok: false, error: "down" }) };
    const good = fakeDecider("good", () => ({ kind: "noul", noul: 0.9 }));
    const registry = defaultRegistry().registerProvider("fake", (c) => ({ ok: true, value: c.id === "bad" ? bad : good }));
    const e = createEngine({ registry, providers: [{ id: "bad", type: "fake", fallback: ["good"] }, { id: "good", type: "fake" }], flows: [flow("f").node("d", "decision", { provider: "bad", kind: "noul", prompt: "q" }).build()] });
    if (!e.ok) throw new Error(e.error);
    const r = await e.value.run("f");
    expect(r.ok && r.value.nodes.d?.result?.output).toBe("0.9");
  });
});
