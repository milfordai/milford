import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, flow, withBreaker, withRateLimit, type DecideRequest, type Provider } from "./index.js";

const req: DecideRequest = { kind: "noul", prompt: "q" };
const flaky = (results: boolean[]): Provider & { calls: number } => {
  const p = { id: "p", type: "t", capabilities: ["decide" as const], calls: 0, decide: async () => (results[p.calls++] ?? true ? { ok: true as const, value: { kind: "noul" as const, noul: 1 } } : { ok: false as const, error: "boom" }) };
  return p;
};

describe("withBreaker", () => {
  it("opens after N failures, fails fast, then closes after a successful trial", async () => {
    let t = 0;
    const inner = flaky([false, false, true, true]);
    const p = withBreaker(inner, { failures: 2, resetMs: 1000 }, () => t);
    expect((await p.decide!(req)).ok).toBe(false);
    expect((await p.decide!(req)).ok).toBe(false);
    const open = await p.decide!(req);
    expect(open).toEqual({ ok: false, error: 'circuit open for provider "p"' });
    expect(inner.calls).toBe(2); // fail-fast did not reach the provider
    t = 1500;
    expect((await p.decide!(req)).ok).toBe(true); // trial succeeds, circuit closes
    expect((await p.decide!(req)).ok).toBe(true);
    expect(inner.calls).toBe(4);
  });

  it("stays open when the trial fails, and lets only one trial through", async () => {
    let t = 0;
    const inner = flaky([false, false, false]);
    const p = withBreaker(inner, { failures: 2, resetMs: 1000 }, () => t);
    await p.decide!(req);
    await p.decide!(req);
    t = 1500;
    const [a, b] = await Promise.all([p.decide!(req), p.decide!(req)]);
    expect([a.ok, b.ok].sort()).toEqual([false, false]);
    expect(inner.calls).toBe(3);
    expect((await p.decide!(req)).ok).toBe(false); // reopened, no call
    expect(inner.calls).toBe(3);
  });

  it("does not count caller-cancelled calls as failures", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = flaky([false, false, false]);
    const p = withBreaker(inner, { failures: 2, resetMs: 1000 });
    for (let i = 0; i < 3; i++) await p.decide!({ ...req, signal: ac.signal });
    expect(inner.calls).toBe(3); // circuit never opened
  });
});

describe("withRateLimit", () => {
  it("spaces calls beyond the burst", async () => {
    const p = withRateLimit(flaky([]), { perSecond: 20, burst: 1 });
    const start = performance.now();
    await Promise.all([p.decide!(req), p.decide!(req), p.decide!(req)]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(90); // 2 waits of ~50ms
  });

  it("gives up when aborted while waiting", async () => {
    const p = withRateLimit(flaky([]), { perSecond: 0.1, burst: 1 });
    await p.decide!(req);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const r = await p.decide!({ ...req, signal: ac.signal });
    expect(r.ok).toBe(false);
  });
});

it("engine applies breaker so the fallback takes over immediately", async () => {
  const bad = flaky([false, false, false, false]);
  const good: Provider = { id: "good", type: "t", capabilities: ["decide"], decide: async () => ({ ok: true, value: { kind: "noul", noul: 0.5 } }) };
  const registry = defaultRegistry().registerProvider("t", (c) => ({ ok: true, value: c.id === "bad" ? { ...bad, id: "bad" } : good }));
  const e = createEngine({
    registry,
    providers: [{ id: "bad", type: "t", circuitBreaker: { failures: 1, resetMs: 60000 }, fallback: ["good"] }, { id: "good", type: "t" }],
    flows: [flow("f").node("d", "decision", { provider: "bad", kind: "noul", prompt: "q" }).build()],
  });
  if (!e.ok) throw new Error(e.error);
  for (let i = 0; i < 3; i++) expect((await e.value.run("f")).ok).toBe(true);
  expect(bad.calls).toBe(1); // opened after the first failure; later runs skip it
});
