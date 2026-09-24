import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider } from "../src/fake-provider.js";
import { runCli, startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { helloFlow, decisionFlow, retryFlow, cacheFlow, branchedFlow, unknownTemplateFlow, cycleFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";

let fake: FakeProvider;
let server: RunningServer;

const rules = [
  // decision: "positive" with confidence above the 0.5 gate.
  { type: "decide", match: "Rate the sentiment", result: { choice: "positive", confidence: 0.9 } },
  // decision: a low-confidence answer, expected to become `none_of_these`.
  { type: "decide", match: "Rate the sentiment", result: { choice: "negative", confidence: 0.2 } },
  // retry flow: first `llm` call fails, the retry succeeds.
  { type: "chat-error", match: "Say hi", status: 500, body: "boom" },
  { type: "chat", match: "Say hi", result: { text: "hi from retry" } },
] as const;

beforeAll(async () => {
  fake = await new FakeProvider().start([...rules]);
  const { config, files } = serverConfig(fake.url, {
    "flows/hello.json": helloFlow,
    "flows/decision.json": decisionFlow,
    "flows/retry.json": retryFlow,
    "flows/cache.json": cacheFlow,
    "flows/branched.json": branchedFlow,
    "flows/unknown-template.json": unknownTemplateFlow,
  });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("flow semantics", () => {
  it("runs a hello prompt and returns the templated greeting", async () => {
    const { status, body } = await runFlow(server.url, "hello", { name: "Iwan" }, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.output?.output).toBe("Hello Iwan!");
    expect(body.nodes.greet?.result?.output).toBe("Hello Iwan!");
  });

  it("returns a typed decision from the provider and gates on minConfidence", async () => {
    const { status, body } = await runFlow(server.url, "decide", {}, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.nodes.d?.result?.data).toMatchObject({ choice: "positive", confidence: 0.9 });
    expect(body.output?.output).toBe("positive");
  });

  it("a low-confidence choice becomes none_of_these and sets gated", async () => {
    const { body } = await runFlow(server.url, "decide", {}, TOKEN);
    expect(body.ok).toBe(true);
    const d = body.nodes.d!.result!.data as { choice: string; gated: boolean; confidence: number };
    expect(d.choice).toBe("none_of_these");
    expect(d.gated).toBe(true);
    expect(d.confidence).toBe(0.2);
    expect(body.output?.output).toBe("none_of_these");
  });

  it("retries a failed provider call and succeeds on the second attempt", async () => {
    const { status, body } = await runFlow(server.url, "retry", {}, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.output?.output).toBe("hi from retry");
    // One failed answer + one success = two `/chat/completions` calls for "Say hi".
    expect(fake.count("Say hi")).toBe(2);
  });

  it("branch conditions: the unmatched edge is skipped but the flow still completes", async () => {
    // Prompt nodes never call the provider, so this flow consumes no fake rules.
    const { status, body } = await runFlow(server.url, "branched", { v: "yes" }, TOKEN);
    expect(status).toBe(200);
    // Edge b requires `output == "V no"`, never lives, so `join` is skipped and the output template is skipped.
    expect(body.nodes.b?.status).toBe("skipped");
    expect(body.nodes.join?.status).toBe("skipped");
    expect(body.errors).toBeUndefined();
  });

  it("an unknown template variable fails the node and names it", async () => {
    const { status, body } = await runFlow(server.url, "unknown-template", {}, TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.nodes.boom?.status).toBe("error");
    expect(body.nodes.boom?.result?.error).toContain("missing.variable");
  });

  it("a cache hit returns the earlier result without rerunning the flow", async () => {
    const first = await runFlow(server.url, "cached", { n: 1 }, TOKEN);
    expect(first.status).toBe(200);
    expect(first.body.cache).toBe("miss");
    const second = await runFlow(server.url, "cached", { n: 1 }, TOKEN);
    expect(second.status).toBe(200);
    expect(second.body.cache).toBe("hit");
    expect(second.body.runId).toBe(first.body.runId);
  });

  it("a different input is a cache miss and runs the flow again", async () => {
    const first = await runFlow(server.url, "cached", { n: 7 }, TOKEN);
    expect(first.body.cache).toBe("miss");
    const second = await runFlow(server.url, "cached", { n: 8 }, TOKEN);
    expect(second.body.cache).toBe("miss");
    expect(second.body.runId).not.toBe(first.body.runId);
  });
});

describe("load-time failures", () => {
  it("a flow with a cycle fails `validate` with the engine's own error", async () => {
    const { config, files } = serverConfig("http://127.0.0.1:1", { "flows/cycle.json": cycleFlow });
    const { code, out } = await runCli("validate", config, { files });
    expect(code).toBe(1);
    expect(out).toContain('flow "cycle": flow contains a cycle');
  });

  it("an unknown node type fails at load and names the node", async () => {
    const bad = { ...helloFlow, nodes: [{ id: "x", type: "nope" }], edges: [] };
    const { config, files } = serverConfig("http://127.0.0.1:1", { "flows/bad.json": bad });
    const { code, out } = await runCli("validate", config, { files });
    expect(code).toBe(1);
    expect(out).toContain('node "x": unknown node type "nope"');
  });
});
