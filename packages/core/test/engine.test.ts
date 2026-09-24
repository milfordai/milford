import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, INVALID_INPUT, memoryRunCache, TOO_MANY_RUNS } from "../src/index.js";

let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));
const registry = defaultRegistry()
  .registerNode("slow", { run: async () => (await gate, { success: true }) })
  .registerNode("hang", { run: (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ success: false, error: "aborted" }))) });
const flows = [
  { id: "slow", nodes: [{ id: "a", type: "slow" }], edges: [] },
  { id: "hang", nodes: [{ id: "a", type: "hang" }], edges: [] },
];
const make = (config: object) => {
  const engine = createEngine({ registry, flows, ...config });
  if (!engine.ok) throw new Error(engine.error);
  return engine.value;
};

describe("engine limits", () => {
  it("rejects runs over maxConcurrentRuns and accepts again once one finishes", async () => {
    const engine = make({ maxConcurrentRuns: 1 });
    const first = engine.run("slow");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await engine.run("slow")).toEqual({ ok: false, error: TOO_MANY_RUNS });
    release();
    expect((await first).ok).toBe(true);
    expect((await engine.run("slow")).ok).toBe(true);
  });

  it("applies a default timeout, which a run can override", async () => {
    const engine = make({ timeoutMs: 20 });
    const result = await engine.run("hang");
    expect(result.ok && result.value.ok).toBe(false); // aborted by the default timeout
    const start = performance.now();
    await engine.run("hang", {}, { timeoutMs: 60 });
    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
  });
});

describe("input validation", () => {
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const withInput = (input: Record<string, unknown>) => createEngine({ registry, flows: [{ id: "f", input, nodes: [{ id: "a", type: "slow" }], edges: [] }] });

  it("rejects input that does not match the declared schema, and runs valid input", async () => {
    release();
    const engine = withInput(schema);
    if (!engine.ok) throw new Error(engine.error);
    const badResult = await engine.value.run("f", {});
    expect(!badResult.ok && badResult.error.startsWith(INVALID_INPUT)).toBe(true);
    expect((await engine.value.run("f", { name: 1 })).ok).toBe(false);
    expect((await engine.value.run("f", { name: "Ann" })).ok).toBe(true);
  });

  it("fails at startup on a schema that cannot be compiled", () => {
    expect(withInput({ type: "nope" }).ok).toBe(false);
  });
});

describe("flow cache", () => {
  let calls = 0;
  const cached = defaultRegistry()
    .registerNode("count", { run: async (ctx) => (calls++, { success: !ctx.input.fail, output: `run ${calls}` }) })
    .registerNode("out", defaultRegistry().nodes.get("output")!);
  const flow = (id: string, cache?: { mode: "direct"; ttlMs: number }) => ({ id, cache, nodes: [{ id: "c", type: "count" }, { id: "o", type: "output" }], edges: [{ from: "c", to: "o" }] });
  const build = (extra: object = {}, flows = [flow("cached", { mode: "direct", ttlMs: 60_000 }), flow("plain")]) => {
    const engine = createEngine({ registry: cached, flows, ...extra });
    if (!engine.ok) throw new Error(engine.error);
    calls = 0;
    return engine.value;
  };
  const run = async (engine: ReturnType<typeof build>, id: string, input: Record<string, unknown> = {}, opts = {}) => {
    const result = await engine.run(id, input, opts);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it("runs a cached flow once for identical input, whatever the key order", async () => {
    const engine = build();
    const first = await run(engine, "cached", { a: 1, b: { c: 2, d: 3 } });
    const second = await run(engine, "cached", { b: { d: 3, c: 2 }, a: 1 });
    expect(calls).toBe(1);
    expect([first.cache, second.cache]).toEqual(["miss", "hit"]);
    expect(second.runId).toBe(first.runId);
    await run(engine, "cached", { a: 2 });
    expect(calls).toBe(2); // different input is a miss
  });

  it("does not touch flows without cache", async () => {
    const engine = build();
    const result = await run(engine, "plain");
    await run(engine, "plain");
    expect(calls).toBe(2);
    expect(result.cache).toBeUndefined();
  });

  it("expires entries after the ttl", async () => {
    const engine = build({}, [flow("cached", { mode: "direct", ttlMs: 20 })]);
    await run(engine, "cached");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await run(engine, "cached")).cache).toBe("miss");
    expect(calls).toBe(2);
  });

  it("refresh skips the lookup and stores the fresh result, off does neither", async () => {
    const engine = build();
    await run(engine, "cached");
    expect((await run(engine, "cached", {}, { cache: "refresh" })).cache).toBe("miss");
    expect(calls).toBe(2);
    expect((await run(engine, "cached")).output?.output).toBe("run 2"); // the refreshed result is what a later hit returns
    const off = await run(engine, "cached", { other: 1 }, { cache: "off" });
    expect(off.cache).toBe("miss");
    expect((await run(engine, "cached", { other: 1 })).cache).toBe("miss"); // "off" stored nothing
  });

  it("does not keep failed runs, and does not cache runs that stream events", async () => {
    const engine = build();
    await run(engine, "cached", { fail: true });
    await run(engine, "cached", { fail: true });
    expect(calls).toBe(2);
    const events: string[] = [];
    await run(engine, "cached", { s: 1 }, { onEvent: (event: { type: string }) => events.push(event.type) });
    expect((await run(engine, "cached", { s: 1 })).cache).toBe("miss"); // the streamed run stored nothing
    expect(events.length).toBeGreaterThan(0);
  });

  it("serves hits while the engine is at its concurrency limit", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const reg = cached.registerNode("hold", { run: async () => (await gate, { success: true }) });
    const engine = createEngine({ registry: reg, maxConcurrentRuns: 1, flows: [flow("cached", { mode: "direct", ttlMs: 60_000 }), { id: "hold", nodes: [{ id: "h", type: "hold" }], edges: [] }] });
    if (!engine.ok) throw new Error(engine.error);
    calls = 0;
    await run(engine.value, "cached");
    const holder = engine.value.run("hold"); // takes the only slot
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await run(engine.value, "cached")).cache).toBe("hit");
    const miss = await engine.value.run("cached", { other: 1 });
    expect(!miss.ok && miss.error).toBe(TOO_MANY_RUNS); // a miss still needs a slot
    open();
    await holder;
    expect(calls).toBe(1);
  });

  it("keeps entries apart when the flow or the provider config changes", async () => {
    const shared = memoryRunCache();
    const reg = cached.registerProvider("fake", (config) => ({ ok: true, value: { id: config.id, type: "fake", capabilities: ["chat"] } }));
    const withCfg = (flows: ReturnType<typeof flow>[], providers: { id: string; type: string; model?: string }[]) => {
      const engine = createEngine({ registry: reg, flows, providers, runCache: shared });
      if (!engine.ok) throw new Error(engine.error);
      return engine.value;
    };
    const cachedFlow = flow("cached", { mode: "direct", ttlMs: 60_000 });
    await run(withCfg([cachedFlow], [{ id: "p", type: "fake", model: "a" }]), "cached");
    expect((await run(withCfg([cachedFlow], [{ id: "p", type: "fake", model: "a" }]), "cached")).cache).toBe("hit"); // same config: shared hit
    expect((await run(withCfg([cachedFlow], [{ id: "p", type: "fake", model: "b" }]), "cached")).cache).toBe("miss"); // another model
    expect((await run(withCfg([{ ...cachedFlow, nodes: [...cachedFlow.nodes], description: "v2" } as typeof cachedFlow], [{ id: "p", type: "fake", model: "a" }]), "cached")).cache).toBe("miss"); // another flow
  });
});

describe("fallback cycle detection", () => {
  const registry = defaultRegistry().registerProvider("t", (config) => ({ ok: true, value: { id: config.id, type: "t", capabilities: ["decide" as const], decide: async () => ({ ok: true, value: { kind: "noul" as const, noul: 0.5 } }) } }));
  const build = (providers: { id: string; type: string; fallback?: string[] }[]) => createEngine({ registry, providers, flows: [{ id: "f", nodes: [{ id: "d", type: "decision", config: { provider: "a", kind: "noul", prompt: "q" } }], edges: [] }] });

  it("rejects a provider falling back to itself", () => {
    expect(build([{ id: "a", type: "t", fallback: ["a"] }]).ok).toBe(false);
  });

  it("rejects a two-provider fallback cycle", () => {
    expect(build([
      { id: "a", type: "t", fallback: ["b"] },
      { id: "b", type: "t", fallback: ["a"] },
    ]).ok).toBe(false);
  });

  it("rejects a cycle through a non-first fallback", () => {
    expect(build([
      { id: "a", type: "t", fallback: ["b"] },
      { id: "b", type: "t", fallback: ["c", "a"] },
      { id: "c", type: "t" },
    ]).ok).toBe(false);
  });

  it("rejects a longer fallback cycle", () => {
    expect(build([
      { id: "a", type: "t", fallback: ["b"] },
      { id: "b", type: "t", fallback: ["c"] },
      { id: "c", type: "t", fallback: ["a"] },
    ]).ok).toBe(false);
  });

  it("allows a non-cyclic fallback chain", () => {
    const engine = build([
      { id: "a", type: "t", fallback: ["b"] },
      { id: "b", type: "t", fallback: ["c"] },
      { id: "c", type: "t" },
    ]);
    expect(engine.ok).toBe(true);
  });
});
