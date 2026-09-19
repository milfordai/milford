import { describe, expect, it } from "vitest";
import { compileFlow, runFlow, type Flow, type NodeRunner } from "./index.js";

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
  it("runs a level in parallel and respects concurrency", async () => {
    let active = 0, peak = 0;
    const slow: NodeRunner = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { success: true };
    };
    const c = compile({ id: "f", nodes: [n("a"), n("b"), n("c"), n("d")], edges: [] });
    await runFlow(c, { runners: { t: slow } });
    expect(peak).toBe(4);
    peak = 0;
    await runFlow(c, { runners: { t: slow }, concurrency: 2 });
    expect(peak).toBe(2);
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
    const r = await runFlow(c, { runners: { decide: async () => ({ success: true, data: { choice: "y" } }), t: echo } });
    expect(Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, v.status]))).toEqual({
      d: "done", yes: "done", no: "skipped", "after-no": "skipped", join: "done",
    });
  });

  it("returns errors instead of throwing, skips downstream, emits events", async () => {
    const events: string[] = [];
    const c = compile({ id: "f", nodes: [n("a", "boom"), n("b")], edges: [{ from: "a", to: "b" }] });
    const r = await runFlow(c, { runners: { boom: async () => { throw new Error("bad"); }, t: echo }, onEvent: (e) => events.push(`${e.type}:${e.nodeId}`) });
    expect(r.ok).toBe(false);
    expect(r.nodes.a?.result?.error).toBe("bad");
    expect(r.nodes.b?.status).toBe("skipped");
    expect(events).toEqual(["node:start:a", "node:error:a", "node:skipped:b"]);
  });

  it("aborts on timeout", async () => {
    const wait: NodeRunner = (ctx) => new Promise((res) => ctx.signal.addEventListener("abort", () => res({ success: false, error: "aborted" })));
    const c = compile({ id: "f", nodes: [n("a")], edges: [] });
    const r = await runFlow(c, { runners: { t: wait }, timeoutMs: 20 });
    expect(r.ok).toBe(false);
  });
});
