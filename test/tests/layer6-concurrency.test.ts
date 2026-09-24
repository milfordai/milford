import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { llmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";
import { elapsedOf, waitUntil } from "../src/timing.js";

let fake: FakeProvider;
let server: RunningServer;

beforeAll(async () => {
  fake = await new FakeProvider().start([
    // A default echo rule answers every chat call, so identical requests are indistinguishable.
    { type: "chat", model: "fake-model", result: { text: "echo: {{prompt}}" } },
    { type: "chat", match: "CONCURRENCY slow", latencyMs: 900, result: { text: "slow answer" } },
  ] as Rule[]);
  const { config, files } = serverConfig(fake.url, {
    "flows/same.json": llmFlow("same", "fake", "CONCURRENCY identical"),
    "flows/slow.json": llmFlow("slow", "fake", "CONCURRENCY slow"),
  });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("MIL-70: concurrency", () => {
  it("two identical requests at the same moment both run, each with its own trace", async () => {
    const before = fake.count("CONCURRENCY identical");
    const [first, second] = await Promise.all([
      runFlow(server.url, "same", {}, TOKEN),
      runFlow(server.url, "same", {}, TOKEN),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(second.body.ok).toBe(true);
    // Both executed (no dedup or rejection) and each kept its own run id.
    expect(first.body.runId).not.toBe(second.body.runId);
    expect(fake.count("CONCURRENCY identical")).toBe(before + 2);
    // The two answers are identical, and each run saw the same nodes.
    expect(first.body.output?.output).toBe("echo: CONCURRENCY identical");
    expect(second.body.output?.output).toBe("echo: CONCURRENCY identical");
  });

  it("the same Idempotency-Key arriving while the first is running waits and replays the first result", async () => {
    const slowRun = runFlow(server.url, "slow", { tag: "idem" }, TOKEN, { "Idempotency-Key": "while-running" });
    // Wait until the slow run is truly in flight, then send the duplicate.
    await waitUntil(() => fake.count("CONCURRENCY slow") >= 1, 5000);

    const { value: replay, ms } = await elapsedOf(() => runFlow(server.url, "slow", { tag: "idem" }, TOKEN, { "Idempotency-Key": "while-running" }));
    const finished = await slowRun;

    // The duplicate waited for the running request instead of running the flow again.
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.body.runId).toBe(finished.body.runId);
    expect(fake.count("CONCURRENCY slow")).toBe(1); // exactly one execution
    expect(ms).toBeGreaterThanOrEqual(300); // it really waited for the in-flight run
  });

  it("the same Idempotency-Key with a different input is a 422, even while the first is running", async () => {
    const slowRun = runFlow(server.url, "slow", { tag: "conflict" }, TOKEN, { "Idempotency-Key": "conflicting" });
    await waitUntil(() => fake.count("CONCURRENCY slow") >= 2, 5000);

    const conflicting = await runFlow(server.url, "slow", { tag: "different" }, TOKEN, { "Idempotency-Key": "conflicting" });
    expect(conflicting.status).toBe(422);
    expect(conflicting.body.error).toContain("already used with a different request");
    await slowRun;
  });
});
