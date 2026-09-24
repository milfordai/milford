import { describe, expect, it } from "vitest";
import { createEngine, defaultRegistry, flow, withBreaker, withRateLimit, type DecideRequest, type Provider } from "../src/index.js";

const request: DecideRequest = { kind: "noul", prompt: "q" };
const flaky = (results: boolean[]): Provider & { calls: number } => {
  const provider = { id: "p", type: "t", capabilities: ["decide" as const], calls: 0, decide: async () => (results[provider.calls++] ?? true ? { ok: true as const, value: { kind: "noul" as const, noul: 1 } } : { ok: false as const, error: "boom" }) };
  return provider;
};

describe("withBreaker", () => {
  it("opens after N failures, fails fast, then closes after a successful trial", async () => {
    let clock = 0;
    const inner = flaky([false, false, true, true]);
    const provider = withBreaker(inner, { failures: 2, resetMs: 1000 }, () => clock);
    expect((await provider.decide!(request)).ok).toBe(false);
    expect((await provider.decide!(request)).ok).toBe(false);
    const open = await provider.decide!(request);
    expect(open).toEqual({ ok: false, error: 'circuit open for provider "p"' });
    expect(inner.calls).toBe(2); // fail-fast did not reach the provider
    clock = 1500;
    expect((await provider.decide!(request)).ok).toBe(true); // trial succeeds, circuit closes
    expect((await provider.decide!(request)).ok).toBe(true);
    expect(inner.calls).toBe(4);
  });

  it("stays open when the trial fails, and lets only one trial through", async () => {
    let clock = 0;
    const inner = flaky([false, false, false]);
    const provider = withBreaker(inner, { failures: 2, resetMs: 1000 }, () => clock);
    await provider.decide!(request);
    await provider.decide!(request);
    clock = 1500;
    const [first, second] = await Promise.all([provider.decide!(request), provider.decide!(request)]);
    expect([first.ok, second.ok].sort()).toEqual([false, false]);
    expect(inner.calls).toBe(3);
    expect((await provider.decide!(request)).ok).toBe(false); // reopened, no call
    expect(inner.calls).toBe(3);
  });

  it("does not count caller-cancelled calls as failures", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = flaky([false, false, false]);
    const provider = withBreaker(inner, { failures: 2, resetMs: 1000 });
    for (let index = 0; index < 3; index++) await provider.decide!({ ...request, signal: ac.signal });
    expect(inner.calls).toBe(3); // circuit never opened
  });
});

describe("withRateLimit", () => {
  it("spaces calls beyond the burst", async () => {
    const provider = withRateLimit(flaky([]), { perSecond: 20, burst: 1 });
    const start = performance.now();
    await Promise.all([provider.decide!(request), provider.decide!(request), provider.decide!(request)]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(90); // 2 waits of ~50ms
  });

  it("gives up when aborted while waiting", async () => {
    const provider = withRateLimit(flaky([]), { perSecond: 0.1, burst: 1 });
    await provider.decide!(request);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const result = await provider.decide!({ ...request, signal: ac.signal });
    expect(result.ok).toBe(false);
  });
});

it("engine applies breaker so the fallback takes over immediately", async () => {
  const bad = flaky([false, false, false, false]);
  const good: Provider = { id: "good", type: "t", capabilities: ["decide"], decide: async () => ({ ok: true, value: { kind: "noul", noul: 0.5 } }) };
  const registry = defaultRegistry().registerProvider("t", (config) => ({ ok: true, value: config.id === "bad" ? { ...bad, id: "bad" } : good }));
  const engine = createEngine({
    registry,
    providers: [{ id: "bad", type: "t", circuitBreaker: { failures: 1, resetMs: 60000 }, fallback: ["good"] }, { id: "good", type: "t" }],
    flows: [flow("f").node("d", "decision", { provider: "bad", kind: "noul", prompt: "q" }).build()],
  });
  if (!engine.ok) throw new Error(engine.error);
  for (let index = 0; index < 3; index++) expect((await engine.value.run("f")).ok).toBe(true);
  expect(bad.calls).toBe(1); // opened after the first failure; later runs skip it
});
