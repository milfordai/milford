import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, INVALID_INPUT, memoryRunCache, TOO_MANY_RUNS } from "./index.js";

let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const registry = defaultRegistry()
  .registerNode("slow", { run: async () => (await gate, { success: true }) })
  .registerNode("hang", { run: (ctx) => new Promise((res) => ctx.signal.addEventListener("abort", () => res({ success: false, error: "aborted" }))) });
const flows = [
  { id: "slow", nodes: [{ id: "a", type: "slow" }], edges: [] },
  { id: "hang", nodes: [{ id: "a", type: "hang" }], edges: [] },
];
const make = (cfg: object) => {
  const e = createEngine({ registry, flows, ...cfg });
  if (!e.ok) throw new Error(e.error);
  return e.value;
};

describe("engine limits", () => {
  it("rejects runs over maxConcurrentRuns and accepts again once one finishes", async () => {
    const e = make({ maxConcurrentRuns: 1 });
    const first = e.run("slow");
    await new Promise((r) => setTimeout(r, 10));
    expect(await e.run("slow")).toEqual({ ok: false, error: TOO_MANY_RUNS });
    release();
    expect((await first).ok).toBe(true);
    expect((await e.run("slow")).ok).toBe(true);
  });

  it("applies a default timeout, which a run can override", async () => {
    const e = make({ timeoutMs: 20 });
    const r = await e.run("hang");
    expect(r.ok && r.value.ok).toBe(false); // aborted by the default timeout
    const start = performance.now();
    await e.run("hang", {}, { timeoutMs: 60 });
    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
  });
});

describe("input validation", () => {
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const withInput = (input: Record<string, unknown>) => createEngine({ registry, flows: [{ id: "f", input, nodes: [{ id: "a", type: "slow" }], edges: [] }] });

  it("rejects input that does not match the declared schema, and runs valid input", async () => {
    release();
    const e = withInput(schema);
    if (!e.ok) throw new Error(e.error);
    const bad = await e.value.run("f", {});
    expect(!bad.ok && bad.error.startsWith(INVALID_INPUT)).toBe(true);
    expect((await e.value.run("f", { name: 1 })).ok).toBe(false);
    expect((await e.value.run("f", { name: "Ann" })).ok).toBe(true);
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
    const e = createEngine({ registry: cached, flows, ...extra });
    if (!e.ok) throw new Error(e.error);
    calls = 0;
    return e.value;
  };
  const run = async (e: ReturnType<typeof build>, id: string, input: Record<string, unknown> = {}, opts = {}) => {
    const r = await e.run(id, input, opts);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("runs a cached flow once for identical input, whatever the key order", async () => {
    const e = build();
    const first = await run(e, "cached", { a: 1, b: { c: 2, d: 3 } });
    const second = await run(e, "cached", { b: { d: 3, c: 2 }, a: 1 });
    expect(calls).toBe(1);
    expect([first.cache, second.cache]).toEqual(["miss", "hit"]);
    expect(second.runId).toBe(first.runId);
    await run(e, "cached", { a: 2 });
    expect(calls).toBe(2); // different input is a miss
  });

  it("does not touch flows without cache", async () => {
    const e = build();
    const r = await run(e, "plain");
    await run(e, "plain");
    expect(calls).toBe(2);
    expect(r.cache).toBeUndefined();
  });

  it("expires entries after the ttl", async () => {
    const e = build({}, [flow("cached", { mode: "direct", ttlMs: 20 })]);
    await run(e, "cached");
    await new Promise((r) => setTimeout(r, 40));
    expect((await run(e, "cached")).cache).toBe("miss");
    expect(calls).toBe(2);
  });

  it("refresh skips the lookup and stores the fresh result, off does neither", async () => {
    const e = build();
    await run(e, "cached");
    expect((await run(e, "cached", {}, { cache: "refresh" })).cache).toBe("miss");
    expect(calls).toBe(2);
    expect((await run(e, "cached")).output?.output).toBe("run 2"); // the refreshed result is what a later hit returns
    const off = await run(e, "cached", { other: 1 }, { cache: "off" });
    expect(off.cache).toBe("miss");
    expect((await run(e, "cached", { other: 1 })).cache).toBe("miss"); // "off" stored nothing
  });

  it("does not keep failed runs, and does not cache runs that stream events", async () => {
    const e = build();
    await run(e, "cached", { fail: true });
    await run(e, "cached", { fail: true });
    expect(calls).toBe(2);
    const events: string[] = [];
    await run(e, "cached", { s: 1 }, { onEvent: (ev: { type: string }) => events.push(ev.type) });
    expect((await run(e, "cached", { s: 1 })).cache).toBe("miss"); // the streamed run stored nothing
    expect(events.length).toBeGreaterThan(0);
  });

  it("serves hits while the engine is at its concurrency limit", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const reg = cached.registerNode("hold", { run: async () => (await gate, { success: true }) });
    const e = createEngine({ registry: reg, maxConcurrentRuns: 1, flows: [flow("cached", { mode: "direct", ttlMs: 60_000 }), { id: "hold", nodes: [{ id: "h", type: "hold" }], edges: [] }] });
    if (!e.ok) throw new Error(e.error);
    calls = 0;
    await run(e.value, "cached");
    const holder = e.value.run("hold"); // takes the only slot
    await new Promise((r) => setTimeout(r, 10));
    expect((await run(e.value, "cached")).cache).toBe("hit");
    const miss = await e.value.run("cached", { other: 1 });
    expect(!miss.ok && miss.error).toBe(TOO_MANY_RUNS); // a miss still needs a slot
    open();
    await holder;
    expect(calls).toBe(1);
  });

  it("keeps entries apart when the flow or the provider config changes", async () => {
    const shared = memoryRunCache();
    const reg = cached.registerProvider("fake", (c) => ({ ok: true, value: { id: c.id, type: "fake", capabilities: ["chat"] } }));
    const withCfg = (flows: ReturnType<typeof flow>[], providers: { id: string; type: string; model?: string }[]) => {
      const e = createEngine({ registry: reg, flows, providers, runCache: shared });
      if (!e.ok) throw new Error(e.error);
      return e.value;
    };
    const f = flow("cached", { mode: "direct", ttlMs: 60_000 });
    await run(withCfg([f], [{ id: "p", type: "fake", model: "a" }]), "cached");
    expect((await run(withCfg([f], [{ id: "p", type: "fake", model: "a" }]), "cached")).cache).toBe("hit"); // same config: shared hit
    expect((await run(withCfg([f], [{ id: "p", type: "fake", model: "b" }]), "cached")).cache).toBe("miss"); // another model
    expect((await run(withCfg([{ ...f, nodes: [...f.nodes] , description: "v2" } as typeof f], [{ id: "p", type: "fake", model: "a" }]), "cached")).cache).toBe("miss"); // another flow
  });
});
