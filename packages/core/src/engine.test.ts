import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, TOO_MANY_RUNS } from "./index.js";

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
