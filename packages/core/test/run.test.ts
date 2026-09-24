import { describe, expect, it } from "vitest";
import { compileFlow, lruCache, Registry, runFlow, type Flow, type NodeContext, type NodeResult, type RunDeps } from "../src/index.js";

type NodeRunner = (ctx: NodeContext, upstream: Record<string, NodeResult>) => Promise<NodeResult>;
const deps = (runners: Record<string, NodeRunner>, extra: Partial<RunDeps> = {}): RunDeps => {
  const registry = new Registry();
  for (const [type, run] of Object.entries(runners)) registry.registerNode(type, { run });
  return { registry, ...extra };
};

const node = (id: string, type = "t") => ({ id, type });
const compile = (flow: Flow) => {
  const result = compileFlow(flow);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const echo: NodeRunner = async (ctx) => ({ success: true, output: String(ctx.config.out ?? "") });

describe("compileFlow", () => {
  it("levels nodes topologically", () => {
    const compiled = compile({ id: "f", nodes: [node("a"), node("b"), node("c")], edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }] });
    expect(compiled.levels.map((level) => level.map((item) => item.id))).toEqual([["a", "b"], ["c"]]);
  });
  it("rejects cycles, duplicates and unknown refs", () => {
    expect(compileFlow({ id: "f", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] })).toEqual({ ok: false, error: "flow contains a cycle" });
    expect(compileFlow({ id: "f", nodes: [node("a"), node("a")], edges: [] }).ok).toBe(false);
    expect(compileFlow({ id: "f", nodes: [node("a")], edges: [{ from: "a", to: "x" }] }).ok).toBe(false);
  });
});

describe("runFlow", () => {
  it("runs a level in parallel", async () => {
    let active = 0, peak = 0;
    const slow: NodeRunner = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { success: true };
    };
    await runFlow(compile({ id: "f", nodes: [node("a"), node("b"), node("c"), node("d")], edges: [] }), deps({ t: slow }));
    expect(peak).toBe(4);
  });

  it("skips untaken branches and their descendants, but joins on any live edge", async () => {
    const compiled = compile({
      id: "f",
      nodes: [node("d", "decide"), node("yes"), node("no"), node("after-no"), node("join")],
      edges: [
        { from: "d", to: "yes", when: { path: "data.choice", op: "eq", value: "y" } },
        { from: "d", to: "no", when: { path: "data.choice", op: "eq", value: "n" } },
        { from: "no", to: "after-no" },
        { from: "yes", to: "join" },
        { from: "after-no", to: "join" },
      ],
    });
    const result = await runFlow(compiled, deps({ decide: async () => ({ success: true, data: { choice: "y" } }), t: echo }));
    expect(Object.fromEntries(Object.entries(result.nodes).map(([key, state]) => [key, state.status]))).toEqual({
      d: "done", yes: "done", no: "skipped", "after-no": "skipped", join: "done",
    });
  });

  it("returns errors instead of throwing, skips downstream, emits events", async () => {
    const events: string[] = [];
    const compiled = compile({ id: "f", nodes: [node("a", "boom"), node("b")], edges: [{ from: "a", to: "b" }] });
    const result = await runFlow(compiled, deps({ boom: async () => { throw new Error("bad"); }, t: echo }), { onEvent: (event) => events.push(`${event.type}:${"nodeId" in event ? event.nodeId : ""}`) });
    expect(result.ok).toBe(false);
    expect(result.nodes.a?.result?.error).toBe("bad");
    expect(result.nodes.b?.status).toBe("skipped");
    expect(events).toEqual(["node:start:a", "node:error:a", "node:skipped:b"]);
  });

  it("aborts on timeout", async () => {
    const wait: NodeRunner = (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ success: false, error: "aborted" })));
    const compiled = compile({ id: "f", nodes: [node("a")], edges: [] });
    const result = await runFlow(compiled, deps({ t: wait }), { timeoutMs: 20 });
    expect(result.ok).toBe(false);
  });

  it("marks a run cut short by its own timeout, but not one aborted by the caller", async () => {
    const ignoresSignal: NodeRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { success: true };
    };
    const flow = () => compile({ id: "f", nodes: [node("a", "slow"), node("b")], edges: [{ from: "a", to: "b" }] });

    const timedOut = await runFlow(flow(), deps({ slow: ignoresSignal, t: echo }), { timeoutMs: 15 });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.nodes.b?.result?.error).toBe("aborted"); // a node that never started reports "aborted", not "not run"

    const controller = new AbortController();
    const aborted = runFlow(flow(), deps({ slow: ignoresSignal, t: echo }), { signal: controller.signal });
    controller.abort();
    expect((await aborted).timedOut).toBeUndefined();
  });

  it("keeps running when an event subscriber throws", async () => {
    const compiled = compile({ id: "f", nodes: [node("a")], edges: [] });
    const result = await runFlow(compiled, deps({ t: echo }), { onEvent: () => { throw new Error("subscriber blew up"); } });
    expect(result.ok).toBe(true);
    expect(result.nodes.a?.status).toBe("done");
  });

  it('join "all" requires every incoming edge to be live', async () => {
    const yes = { path: "data.v", op: "eq" as const, value: 1 };
    const makeFlow = (join?: "all") => compile({
      id: "f",
      nodes: [node("a", "a"), node("b", "b"), { ...node("c"), join }],
      edges: [{ from: "a", to: "c", when: yes }, { from: "b", to: "c" }],
    });
    const runners = { a: async () => ({ success: true, data: { v: 2 } }), b: async () => ({ success: true }), t: echo };
    expect((await runFlow(makeFlow(), deps(runners))).nodes.c?.status).toBe("done");
    expect((await runFlow(makeFlow("all"), deps(runners))).nodes.c?.status).toBe("skipped");
  });

  it("retries failed nodes with backoff", async () => {
    let calls = 0;
    const flaky: NodeRunner = async () => (++calls < 3 ? { success: false, error: "no" } : { success: true });
    const compiled = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 3, backoffMs: 1, on: "all" } }], edges: [] });
    expect((await runFlow(compiled, deps({ t: flaky }))).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("does not retry a failure the node type does not mark retryable", async () => {
    let calls = 0;
    const flaky: NodeRunner = async () => { calls++; return { success: false, error: "no" }; };
    const compiled = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 3, backoffMs: 1 } }], edges: [] });
    const result = await runFlow(compiled, deps({ t: flaky }));
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('retries a failure the node type marks retryable ("on" defaults to infra)', async () => {
    let calls = 0;
    const flaky: NodeRunner = async () => (++calls < 2 ? { success: false, error: "no" } : { success: true });
    const registry = new Registry().registerNode("t", { retryable: () => true, run: flaky });
    const compiled = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 3, backoffMs: 1 } }], edges: [] });
    expect((await runFlow(compiled, { registry })).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('on: "none" never retries, and on: "all" retries anything', async () => {
    let none = 0, all = 0;
    const compiledNone = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 3, backoffMs: 1, on: "none" } }], edges: [] });
    const resultNone = await runFlow(compiledNone, deps({ t: async () => { none++; return { success: false, error: "no" }; } }));
    expect(resultNone.ok).toBe(false);
    expect(none).toBe(1);
    const compiledAll = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 3, backoffMs: 1, on: "all" } }], edges: [] });
    const resultAll = await runFlow(compiledAll, deps({ t: async () => { all++; return { success: false, error: "no" }; } }));
    expect(resultAll.ok).toBe(false);
    expect(all).toBe(3);
  });

  it("caps the backoff wait at maxBackoffMs", async () => {
    let calls = 0;
    const compiled = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 10, backoffMs: 10_000, maxBackoffMs: 50, on: "all" } }], edges: [] });
    const start = performance.now();
    const result = await runFlow(compiled, deps({ t: async () => { calls++; return { success: false, error: "no" }; } }));
    const ms = performance.now() - start;
    expect(result.ok).toBe(false);
    expect(calls).toBe(10);
    // Without the cap, 10 attempts would wait ~5000 seconds; with it, under a second.
    expect(ms).toBeLessThan(1000);
  });

  it("stopDelayMs stops retrying before the attempts run out", async () => {
    let calls = 0;
    const compiled = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 10, backoffMs: 60, stopDelayMs: 40, on: "all" } }], edges: [] });
    const start = performance.now();
    const result = await runFlow(compiled, deps({ t: async () => { calls++; return { success: false, error: "no" }; } }));
    expect(result.ok).toBe(false);
    expect(calls).toBeLessThan(10);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
  });

  it("multiplier changes the backoff growth", async () => {
    const runWith = async (multiplier: number) => {
      const compiled = compile({ id: "f", nodes: [{ ...node("a"), retry: { attempts: 3, backoffMs: 10, multiplier, on: "all" } }], edges: [] });
      const start = performance.now();
      await runFlow(compiled, deps({ t: async () => ({ success: false, error: "no" }) }));
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
    const compiled = compile({ id: "f", nodes: [{ ...node("a"), cache: true }], edges: [] });
    const runDeps = deps({ t: count }, { cache: lruCache() });
    await runFlow(compiled, runDeps);
    const result = await runFlow(compiled, runDeps);
    expect(calls).toBe(1);
    expect(result.nodes.a?.result?.output).toBe("1");
  });

  it("keys memoized results by the run input, and never shares them across flows or nodes", async () => {
    const setKeys: string[] = [];
    const cache = { get: () => undefined, set: (key: string) => void setKeys.push(key) };
    const echoInput: NodeRunner = async (ctx) => ({ success: true, output: `for ${JSON.stringify(ctx.input)}` });
    const runDeps = deps({ t: echoInput }, { cache });

    await runFlow(compile({ id: "f", nodes: [{ ...node("a"), cache: true }], edges: [] }), runDeps, { input: { who: "ann" } });
    await runFlow(compile({ id: "f", nodes: [{ ...node("a"), cache: true }], edges: [] }), runDeps, { input: { who: "bob" } });
    const afterInput = setKeys.length;
    expect(afterInput).toBe(2); // different input: separate entries, never one caller's result for another

    await runFlow(compile({ id: "other", nodes: [{ ...node("a"), cache: true }], edges: [] }), runDeps, { input: { who: "ann" } });
    await runFlow(compile({ id: "f", nodes: [{ ...node("b"), cache: true }], edges: [] }), runDeps, { input: { who: "ann" } });
    expect(setKeys.length).toBe(afterInput + 2); // same input, other flow or node: separate entries too
  });
});
