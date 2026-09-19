import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, INVALID_INPUT, TOO_MANY_RUNS } from "./index.js";

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
