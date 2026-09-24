import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { openaiProvider, serverConfig, TOKEN, typesafeProvider } from "../src/fixtures.js";
import { llmFlow, parallelDecisionFlow, parallelLlmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";
import { elapsedOf, sleep } from "../src/timing.js";

let fake: FakeProvider;
let server: RunningServer;

beforeAll(async () => {
  fake = await new FakeProvider().start([
    // fallback order: alpha and beta each fail once, then gamma answers.
    { type: "chat-error", match: "RESILIENCE order", model: "m-alpha", status: 500, body: "alpha down" },
    { type: "chat-error", match: "RESILIENCE order", model: "m-beta", status: 500, body: "beta down" },
    { type: "chat", model: "m-gamma", result: { text: "answer from gamma" } },
    // breaker: two slow failures open it; after the reset a default rule answers the trial.
    { type: "chat-error", match: "RESILIENCE breaker", model: "m-brk", status: 500, body: "brk down", latencyMs: 400 },
    { type: "chat-error", match: "RESILIENCE breaker", model: "m-brk", status: 500, body: "brk down", latencyMs: 400 },
    { type: "chat", model: "m-brk", result: { text: "answer from brk" } },
    // brittle: one failure opens it, and the post-reset trial fails again.
    { type: "chat-error", match: "RESILIENCE brittle", model: "m-brittle", status: 500, body: "brittle down", latencyMs: 100 },
    { type: "chat-error", model: "m-brittle", status: 500, body: "brittle still down" },
    { type: "chat", model: "m-solid", result: { text: "answer from solid" } },
    // paced: echo default for the rate-limited provider.
    { type: "chat", model: "m-paced", result: { text: "{{prompt}}" } },
    // jevdown: every batch endpoint call fails, so decisions fall back one by one.
    { type: "chat-error", path: "systemone", model: "m-jevdown", status: 500, body: "systemone down" },
    { type: "decide", path: "chat/completions", model: "m-backup", result: { choice: "negative", confidence: 0.8 } },
    // jevup: the batch endpoint answers the whole batch.
    { type: "decide", path: "systemone", model: "m-jevup", result: { choice: "positive", confidence: 0.9 } },
  ] as Rule[]);
  const { config, files } = serverConfig(fake.url, {
    "flows/order.json": llmFlow("order", "alpha", "RESILIENCE order"),
    "flows/breaker.json": llmFlow("breaker", "brk", "RESILIENCE breaker"),
    "flows/brittle.json": llmFlow("brittle", "brittle", "RESILIENCE brittle"),
    "flows/paced.json": parallelLlmFlow("paced", "paced"),
    "flows/batch-fail.json": parallelDecisionFlow("batch-fail", "jevdown", 3),
    "flows/batch-ok.json": parallelDecisionFlow("batch-ok", "jevup", 3),
  }, {
    providers: [
      openaiProvider("alpha", fake.url, "m-alpha", 'fallback: ["beta", "gamma"]'),
      openaiProvider("beta", fake.url, "m-beta"),
      openaiProvider("gamma", fake.url, "m-gamma"),
      openaiProvider("brk", fake.url, "m-brk", 'circuitBreaker: { failures: 2, resetMs: 1500 }, fallback: ["solid"]'),
      openaiProvider("solid", fake.url, "m-solid"),
      openaiProvider("brittle", fake.url, "m-brittle", 'circuitBreaker: { failures: 1, resetMs: 800 }, fallback: ["solid"]'),
      openaiProvider("paced", fake.url, "m-paced", "rateLimit: { perSecond: 4, burst: 1 }"),
      typesafeProvider("jevdown", fake.url, "m-jevdown", 'fallback: ["backup"]'),
      typesafeProvider("jevup", fake.url, "m-jevup"),
      openaiProvider("backup", fake.url, "m-backup"),
    ],
  });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("MIL-70: fallback", () => {
  it("tries the primary, then each fallback in order, until one answers", async () => {
    const { status, body } = await runFlow(server.url, "order", {}, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.output?.output).toBe("answer from gamma");
    // Each provider was called exactly once, in fallback order.
    expect(fake.count('"m-alpha"')).toBe(1);
    expect(fake.count('"m-beta"')).toBe(1);
    expect(fake.count('"m-gamma"')).toBe(1);
    expect(fake.firstIndex('"m-alpha"')).toBeLessThan(fake.firstIndex('"m-beta"'));
    expect(fake.firstIndex('"m-beta"')).toBeLessThan(fake.firstIndex('"m-gamma"'));
  });
});

describe("MIL-70: circuit breaker", () => {
  it("opens after the configured failures, fails fast without calling the provider, then closes after a successful trial", async () => {
    // Two failing calls (scripted slow, so fail-fast is measurable) open the circuit.
    const first = await runFlow(server.url, "breaker", {}, TOKEN);
    expect(first.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brk"')).toBe(1);

    const second = await runFlow(server.url, "breaker", {}, TOKEN);
    expect(second.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brk"')).toBe(2);

    // While open, the breaker answers instantly without reaching the provider.
    const { value: openRun, ms: openMs } = await elapsedOf(() => runFlow(server.url, "breaker", {}, TOKEN));
    expect(openRun.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brk"')).toBe(2); // no third call
    expect(openRun.body.nodes.llm?.ms ?? 0).toBeLessThan(350); // a real call is scripted to take 400ms
    expect(openMs).toBeLessThan(2000);

    // After resetMs the circuit lets one trial call through; success closes it.
    await sleep(1700); // resetMs is 1500, counted from the failure that opened the circuit
    const trial = await runFlow(server.url, "breaker", {}, TOKEN);
    expect(trial.body.output?.output).toBe("answer from brk");
    expect(fake.count('"m-brk"')).toBe(3); // exactly the one trial call

    // Closed again: the next run goes straight to the primary.
    const closed = await runFlow(server.url, "breaker", {}, TOKEN);
    expect(closed.body.output?.output).toBe("answer from brk");
    expect(fake.count('"m-brk"')).toBe(4);
  });

  it("a failed trial re-opens the circuit instead of closing it", async () => {
    // One failure is enough to open the brittle breaker (failures: 1).
    const first = await runFlow(server.url, "brittle", {}, TOKEN);
    expect(first.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brittle"')).toBe(1);

    // While open: fail fast, no provider call.
    const open = await runFlow(server.url, "brittle", {}, TOKEN);
    expect(open.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brittle"')).toBe(1);

    // After resetMs the trial runs and fails, so the circuit re-opens.
    await sleep(900); // resetMs is 800, counted from the failure that opened the circuit
    const trial = await runFlow(server.url, "brittle", {}, TOKEN);
    expect(trial.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brittle"')).toBe(2); // the matched failure and the failed trial

    // Re-opened: the next run fails fast again, without a third provider call.
    const reopened = await runFlow(server.url, "brittle", {}, TOKEN);
    expect(reopened.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brittle"')).toBe(2);
  });
});

describe("MIL-70: provider rate limit", () => {
  it("spaces calls beyond the burst, and the run waits its turn instead of failing", async () => {
    // Two chat calls in the same tick, one token in the bucket: the second waits ~250ms (perSecond 4).
    const { value, ms } = await elapsedOf(() => runFlow(server.url, "paced", {}, TOKEN));
    expect(value.status).toBe(200);
    expect(value.body.ok).toBe(true);
    expect(value.body.output?.output).toBe("Call A on paced|Call B on paced");
    // A lower bound holds on any machine: both calls ran, so at least one spacing wait happened.
    expect(ms).toBeGreaterThanOrEqual(200);
    expect(fake.count('"m-paced"')).toBe(2);
  });
});

describe("MIL-70: batched decisions", () => {
  it("a working batch answers every decision with one call", async () => {
    const { status, body } = await runFlow(server.url, "batch-ok", {}, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.output?.output).toBe("positive|positive|positive");
    // The three decisions issued in the same tick shared one batched call.
    expect(fake.countAll("m-jevup", '"q2"')).toBe(1);
    expect(fake.countAll("m-jevup", '"questions"')).toBe(1);
  });

  it("a failed batch falls back per decision, through the provider chain", async () => {
    const { status, body } = await runFlow(server.url, "batch-fail", {}, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.output?.output).toBe("negative|negative|negative");
    expect(body.nodes.d0?.result?.data).toMatchObject({ choice: "negative", confidence: 0.8 });

    // One batched call (it carries q2), then one single call per decision retrying the primary.
    expect(fake.countAll("m-jevdown", '"q2"')).toBe(1);
    expect(fake.countAll("m-jevdown", '"questions"')).toBe(4);
    // Each decision then fell back to the backup provider, one call each, after the batch.
    expect(fake.countAll("m-backup", "Rate option number")).toBe(3);
    expect(fake.firstIndex('"m-backup"')).toBeGreaterThan(fake.firstIndex('"m-jevdown"'));
  });
});
