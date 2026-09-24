import { describe, expect, it } from "vitest";
import { compileFlow, lruCache, Registry, runFlow, type Flow, type NodeContext, type NodeResult, type RunDeps } from "./index.js";

type NodeRunner = (ctx: NodeContext, up: Record<string, NodeResult>) => Promise<NodeResult>;
const deps = (runners: Record<string, NodeRunner>, extra: Partial<RunDeps> = {}): RunDeps => {
  const registry = new Registry();
  for (const [t, run] of Object.entries(runners)) registry.registerNode(t, { run });
  return { registry, ...extra };
};

const n = (id: string, type = "t") => ({ id, type });
const compile = (f: Flow) => {
  const r = compileFlow(f);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const echo: NodeRunner = async (ctx) => ({ success: true, output: String(ctx.config.out ?? "") });

describe("compileFlow", () => {
  it("levels nodes topologically", () => {
    const c = compile({ id: "f", nodes: [n("a"), n("b"), n("c")], edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }] });
    expect(c.levels.map((l) => l.map((x) => x.id))).toEqual([["a", "b"], ["c"]]);
  });
  it("rejects cycles, duplicates and unknown refs", () => {
    expect(compileFlow({ id: "f", nodes: [n("a"), n("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] })).toEqual({ ok: false, error: "flow contains a cycle" });
    expect(compileFlow({ id: "f", nodes: [n("a"), n("a")], edges: [] }).ok).toBe(false);
    expect(compileFlow({ id: "f", nodes: [n("a")], edges: [{ from: "a", to: "x" }] }).ok).toBe(false);
  });
});

describe("runFlow", () => {
  it("runs a level in parallel", async () => {
    let active = 0, peak = 0;
    const slow: NodeRunner = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { success: true };
    };
    await runFlow(compile({ id: "f", nodes: [n("a"), n("b"), n("c"), n("d")], edges: [] }), deps({ t: slow }));
    expect(peak).toBe(4);
  });

  it("skips untaken branches and their descendants, but joins on any live edge", async () => {
    const c = compile({
      id: "f",
      nodes: [n("d", "decide"), n("yes"), n("no"), n("after-no"), n("join")],
      edges: [
        { from: "d", to: "yes", when: { path: "data.choice", op: "eq", value: "y" } },
        { from: "d", to: "no", when: { path: "data.choice", op: "eq", value: "n" } },
        { from: "no", to: "after-no" },
        { from: "yes", to: "join" },
        { from: "after-no", to: "join" },
      ],
    });
    const r = await runFlow(c, deps({ decide: async () => ({ success: true, data: { choice: "y" } }), t: echo }));
    expect(Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, v.status]))).toEqual({
      d: "done", yes: "done", no: "skipped", "after-no": "skipped", join: "done",
    });
  });

  it("returns errors instead of throwing, skips downstream, emits events", async () => {
    const events: string[] = [];
    const c = compile({ id: "f", nodes: [n("a", "boom"), n("b")], edges: [{ from: "a", to: "b" }] });
    const r = await runFlow(c, deps({ boom: async () => { throw new Error("bad"); }, t: echo }), { onEvent: (e) => events.push(`${e.type}:${"nodeId" in e ? e.nodeId : ""}`) });
    expect(r.ok).toBe(false);
    expect(r.nodes.a?.result?.error).toBe("bad");
    expect(r.nodes.b?.status).toBe("skipped");
    expect(events).toEqual(["node:start:a", "node:error:a", "node:skipped:b"]);
  });

  it("aborts on timeout", async () => {
    const wait: NodeRunner = (ctx) => new Promise((res) => ctx.signal.addEventListener("abort", () => res({ success: false, error: "aborted" })));
    const c = compile({ id: "f", nodes: [n("a")], edges: [] });
    const r = await runFlow(c, deps({ t: wait }), { timeoutMs: 20 });
    expect(r.ok).toBe(false);
  });

  it('join "all" requires every incoming edge to be live', async () => {
    const yes = { path: "data.v", op: "eq" as const, value: 1 };
    const mk = (join?: "all") => compile({
      id: "f",
      nodes: [n("a", "a"), n("b", "b"), { ...n("c"), join }],
      edges: [{ from: "a", to: "c", when: yes }, { from: "b", to: "c" }],
    });
    const runners = { a: async () => ({ success: true, data: { v: 2 } }), b: async () => ({ success: true }), t: echo };
    expect((await runFlow(mk(), deps(runners))).nodes.c?.status).toBe("done");
    expect((await runFlow(mk("all"), deps(runners))).nodes.c?.status).toBe("skipped");
  });

  it("retries failed nodes with backoff", async () => {
    let calls = 0;
    const flaky: NodeRunner = async () => (++calls < 3 ? { success: false, error: "no" } : { success: true });
    const c = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 3, backoffMs: 1, on: "all" } }], edges: [] });
    expect((await runFlow(c, deps({ t: flaky }))).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("does not retry a failure the node type does not mark retryable", async () => {
    let calls = 0;
    const flaky: NodeRunner = async () => { calls++; return { success: false, error: "no" }; };
    const c = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 3, backoffMs: 1 } }], edges: [] });
    const r = await runFlow(c, deps({ t: flaky }));
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('retries a failure the node type marks retryable ("on" defaults to infra)', async () => {
    let calls = 0;
    const flaky: NodeRunner = async () => (++calls < 2 ? { success: false, error: "no" } : { success: true });
    const registry = new Registry().registerNode("t", { retryable: () => true, run: flaky });
    const c = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 3, backoffMs: 1 } }], edges: [] });
    expect((await runFlow(c, { registry }, )).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('on: "none" never retries, and on: "all" retries anything', async () => {
    let none = 0, all = 0;
    const always: NodeRunner = async () => { return { success: false, error: "no" }; };
    const cn = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 3, backoffMs: 1, on: "none" } }], edges: [] });
    const rn = await runFlow(cn, deps({ t: async () => { none++; return { success: false, error: "no" }; } }));
    expect(rn.ok).toBe(false);
    expect(none).toBe(1);
    const ca = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 3, backoffMs: 1, on: "all" } }], edges: [] });
    const ra = await runFlow(ca, deps({ t: async () => { all++; return { success: false, error: "no" }; } }));
    expect(ra.ok).toBe(false);
    expect(all).toBe(3);
  });

  it("caps the backoff wait at maxBackoffMs", async () => {
    let calls = 0;
    const c = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 10, backoffMs: 10_000, maxBackoffMs: 50, on: "all" } }], edges: [] });
    const start = performance.now();
    const r = await runFlow(c, deps({ t: async () => { calls++; return { success: false, error: "no" }; } }));
    const ms = performance.now() - start;
    expect(r.ok).toBe(false);
    expect(calls).toBe(10);
    // Without the cap, 10 attempts would wait ~5000 seconds; with it, under a second.
    expect(ms).toBeLessThan(1000);
  });

  it("stopDelayMs stops retrying before the attempts run out", async () => {
    let calls = 0;
    const c = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 10, backoffMs: 60, stopDelayMs: 40, on: "all" } }], edges: [] });
    const start = performance.now();
    const r = await runFlow(c, deps({ t: async () => { calls++; return { success: false, error: "no" }; } }));
    expect(r.ok).toBe(false);
    expect(calls).toBeLessThan(10);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
  });

  it("multiplier changes the backoff growth", async () => {
    const runWith = async (multiplier: number) => {
      const c = compile({ id: "f", nodes: [{ ...n("a"), retry: { attempts: 3, backoffMs: 10, multiplier, on: "all" } }], edges: [] });
      const start = performance.now();
      await runFlow(c, deps({ t: async () => ({ success: false, error: "no" }) }));
      return performance.now() - start;
    };
    // Waits are 10+20 ms (x2) versus 10+40 ms (x4): the four-times run must take longer.
    const twice = await runWith(2);
    const four = await runWith(4);
    expect(four).toBeGreaterThan(twice);
    expect(four).toBeLessThan(500);
  });

  it("memoizes successful results when cache is on", async () => {
    let calls = 0;
    const count: NodeRunner = async () => ({ success: true, output: String(++calls) });
    const c = compile({ id: "f", nodes: [{ ...n("a"), cache: true }], edges: [] });
    const d = deps({ t: count }, { cache: lruCache() });
    await runFlow(c, d);
    const r = await runFlow(c, d);
    expect(calls).toBe(1);
    expect(r.nodes.a?.result?.output).toBe("1");
  });
});
