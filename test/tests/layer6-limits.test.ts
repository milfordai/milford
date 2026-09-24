import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { openaiProvider, serverConfig, TOKEN } from "../src/fixtures.js";
import { cacheFlow, helloFlow, llmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";
import { elapsedOf, waitUntil } from "../src/timing.js";

let fake: FakeProvider;
let busy: RunningServer; // maxConcurrentRuns: 1, so one in-flight run rejects the next
let timed: RunningServer; // run.timeoutMs: 400, so a hanging provider call is aborted
let override: RunningServer; // the per-request timeout header aborts a hanging call

beforeAll(async () => {
  fake = await new FakeProvider().start([
    // The busy server's provider (model m-busy) always answers slowly; a default rule is never consumed.
    { type: "chat", model: "m-busy", latencyMs: 900, result: { text: "busy slow answer" } },
    // Two one-shot hangs, one per server, each longer than any timeout in play.
    { type: "chat", match: "LIMITS hang", latencyMs: 30_000, result: { text: "way too late" } },
    { type: "chat", match: "LIMITS header hang", latencyMs: 30_000, result: { text: "way too late" } },
  ] as Rule[]);

  const busySetup = serverConfig(fake.url, {
    "flows/busy-slow.json": llmFlow("busy-slow", "fake", "LIMITS busy slow"),
    "flows/cached.json": cacheFlow,
    "flows/hello.json": helloFlow,
  }, { providers: [openaiProvider("fake", fake.url, "m-busy")], run: ["maxConcurrentRuns: 1"], server: ["maxBodyBytes: 2000"] });
  busy = await startServer(busySetup);

  const timedSetup = serverConfig(fake.url, { "flows/hang.json": llmFlow("hang", "fake", "LIMITS hang") }, { run: ["timeoutMs: 400"] });
  timed = await startServer(timedSetup);

  const overrideSetup = serverConfig(fake.url, { "flows/header-hang.json": llmFlow("header-hang", "fake", "LIMITS header hang") });
  override = await startServer(overrideSetup);
});

afterAll(async () => {
  await busy.close();
  await timed.close();
  await override.close();
  await fake.stop();
});

describe("MIL-70: run timeout", () => {
  it("run.timeoutMs aborts an in-flight provider call and fails the node", async () => {
    const { value, ms } = await elapsedOf(() => runFlow(timed.url, "hang", {}, TOKEN));
    expect(value.status).toBe(200); // the run completed; the abort is in the trace
    expect(value.body.ok).toBe(false);
    expect(value.body.nodes.llm?.status).toBe("error");
    expect(value.body.nodes.llm?.result?.error).toMatch(/abort/i);
    expect(value.body.nodes.out?.status).toBe("skipped");
    // The 30s scripted hang was cut short by the 400ms timeout: bounded, never exact milliseconds.
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(5000);
  });

  it("a per-request X-Milford-Timeout-Ms override aborts the run early", async () => {
    const { value, ms } = await elapsedOf(() =>
      runFlow(override.url, "header-hang", {}, TOKEN, { "X-Milford-Timeout-Ms": "300" }),
    );
    expect(value.status).toBe(200);
    expect(value.body.ok).toBe(false);
    expect(value.body.nodes.llm?.result?.error).toMatch(/abort/i);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(5000);
  });
});

describe("MIL-70: maxConcurrentRuns", () => {
  it("a run over the cap is a 503 with Retry-After, and the slot frees when the run finishes", async () => {
    // One slow run takes the only slot; wait until the provider call is truly in flight.
    const slowRun = runFlow(busy.url, "busy-slow", {}, TOKEN);
    await waitUntil(() => fake.count("LIMITS busy slow") >= 1, 5000);

    const rejected = await runFlow(busy.url, "hello", { name: "Second" }, TOKEN);
    expect(rejected.status).toBe(503);
    expect(rejected.body.error).toContain("too many concurrent runs");
    expect(rejected.headers.get("retry-after")).toBe("1");

    // Once the slow run finishes, the same request succeeds.
    const finished = await slowRun;
    expect(finished.status).toBe(200);
    expect(finished.body.output?.output).toBe("busy slow answer");
    const after = await runFlow(busy.url, "hello", { name: "Second" }, TOKEN);
    expect(after.status).toBe(200);
    expect(after.body.ok).toBe(true);
  });

  it("a cache hit is an earlier run, so it does not count against the cap", async () => {
    // Fill the cache while the slot is free.
    const first = await runFlow(busy.url, "cached", { n: 1 }, TOKEN);
    expect(first.body.cache).toBe("miss");

    const slowRun = runFlow(busy.url, "busy-slow", {}, TOKEN);
    await waitUntil(() => fake.count("LIMITS busy slow") >= 2, 5000);

    // A replay of the cached flow answers while the slow run still holds the only slot.
    const hit = await runFlow(busy.url, "cached", { n: 1 }, TOKEN);
    expect(hit.status).toBe(200);
    expect(hit.body.cache).toBe("hit");
    expect(hit.body.runId).toBe(first.body.runId);
    await slowRun;
  });
});

describe("MIL-70: request body limit", () => {
  it("a body over server.maxBodyBytes is a 413", async () => {
    const res = await fetch(`${busy.url}/v1/flows/hello/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input: { pad: "x".repeat(3000) } }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("body too large");
  });
});
