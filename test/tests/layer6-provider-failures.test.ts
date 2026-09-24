import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { decisionFlow, llmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";
import { elapsedOf } from "../src/timing.js";

let fake: FakeProvider;
let server: RunningServer;

beforeAll(async () => {
  fake = await new FakeProvider().start([
    // One plain failure, and two for a retry that exhausts its attempts.
    { type: "chat-error", match: "FAILURES plain error", status: 500, body: "provider exploded" },
    { type: "chat-error", match: "FAILURES exhaust", status: 503, body: "overloaded" },
    { type: "chat-error", match: "FAILURES exhaust", status: 503, body: "overloaded" },
    // A slow answer, a hang-length answer, and three kinds of malformed answers.
    { type: "chat", match: "FAILURES slow", latencyMs: 700, result: { text: "slow but sure" } },
    { type: "chat-malformed", match: "FAILURES not json" },
    { type: "chat-empty", match: "FAILURES no content" },
    { type: "decide-invalid", match: "Rate the sentiment" },
  ] as Rule[]);
  const { config, files } = serverConfig(fake.url, {
    "flows/fail.json": llmFlow("fail", "fake", "FAILURES plain error"),
    "flows/exhaust.json": llmFlow("exhaust", "fake", "FAILURES exhaust", { attempts: 2, backoffMs: 5 }),
    "flows/slow.json": llmFlow("slow", "fake", "FAILURES slow"),
    "flows/malformed.json": llmFlow("malformed", "fake", "FAILURES not json"),
    "flows/empty.json": llmFlow("empty", "fake", "FAILURES no content"),
    "flows/decision.json": decisionFlow,
  });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("MIL-70: provider failures", () => {
  it("an HTTP error from the provider fails the node and names the status and body", async () => {
    const { status, body } = await runFlow(server.url, "fail", {}, TOKEN);
    expect(status).toBe(200); // the run completed; the failure is in the trace
    expect(body.ok).toBe(false);
    expect(body.nodes.llm?.status).toBe("error");
    expect(body.nodes.llm?.result?.error).toContain("HTTP 500");
    expect(body.nodes.llm?.result?.error).toContain("provider exploded");
    expect(body.nodes.out?.status).toBe("skipped");
  });

  it("a retried provider error is attempted again, and exhaustion keeps the last error", async () => {
    const { body } = await runFlow(server.url, "exhaust", {}, TOKEN);
    expect(body.ok).toBe(false);
    expect(body.nodes.llm?.result?.error).toContain("HTTP 503");
    // Two attempts hit the provider, both scripted to fail.
    expect(fake.count("FAILURES exhaust")).toBe(2);
  });

  it("a slow answer still completes the run, after at least the answer's latency", async () => {
    const { value, ms } = await elapsedOf(() => runFlow(server.url, "slow", {}, TOKEN));
    expect(value.status).toBe(200);
    expect(value.body.ok).toBe(true);
    expect(value.body.output?.output).toBe("slow but sure");
    // A lower bound holds on any machine: the run cannot finish before the answer arrives.
    expect(ms).toBeGreaterThanOrEqual(600);
  });

  it("a 200 answer that is not JSON fails the node", async () => {
    const { body } = await runFlow(server.url, "malformed", {}, TOKEN);
    expect(body.ok).toBe(false);
    expect(body.nodes.llm?.status).toBe("error");
    expect(body.nodes.llm?.result?.error).toContain("response was not JSON");
  });

  it("a 200 JSON answer without message content fails the node", async () => {
    const { body } = await runFlow(server.url, "empty", {}, TOKEN);
    expect(body.ok).toBe(false);
    expect(body.nodes.llm?.result?.error).toContain("response had no content");
  });

  it("a decision whose answer is not valid JSON fails the decision node", async () => {
    const { body } = await runFlow(server.url, "decide", {}, TOKEN);
    expect(body.ok).toBe(false);
    expect(body.nodes.d?.status).toBe("error");
    expect(body.nodes.d?.result?.error).toContain("decision was not valid JSON");
  });
});
