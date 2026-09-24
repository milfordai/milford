import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import type { Rule } from "../src/fake-provider.js";

/** A chat flow: an `llm` node answers with the provider's text, the output node forwards it. */
const chatFlow = {
  id: "chat-assistant",
  nodes: [
    { id: "in", type: "input" },
    { id: "llm", type: "llm", config: { provider: "fake", prompt: "{{input.prompt}}" } },
    { id: "out", type: "output", config: { template: "{{llm.output}}" } },
  ],
  edges: [
    { from: "in", to: "llm" },
    { from: "llm", to: "out" },
  ],
};

/** A failing flow for the error-path e2e test. */
const failingFlow = {
  id: "chat-broken",
  nodes: [
    { id: "in", type: "input" },
    { id: "boom", type: "prompt", config: { template: "{{input.missing}}" } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "boom" },
    { from: "boom", to: "out" },
  ],
};

let fake: FakeProvider;
let server: RunningServer;

beforeAll(async () => {
  // One echo rule covers every chat request; the fallback `{{prompt}}` keeps it deterministic.
  const rules: Rule[] = [
    { type: "chat", result: { text: "echo: {{prompt}}" } },
  ];
  fake = await new FakeProvider().start(rules);
  const { config, files } = serverConfig(fake.url, {
    "flows/chat.json": chatFlow,
    "flows/broken.json": failingFlow,
  });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

const completion = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("OpenAI-compatible /v1/chat/completions", () => {
  it("runs the flow named by `model` and returns an OpenAI-shaped response", async () => {
    const res = await completion({ model: "chat-assistant", messages: [{ role: "user", content: "Hello from the SDK" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("chat-assistant");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "echo: Hello from the SDK" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("uses the last user message as the flow prompt and ignores extra OpenAI fields", async () => {
    const res = await completion({
      model: "chat-assistant",
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: "First" }, { role: "assistant", content: "ok" }, { role: "user", content: "Final" }],
      temperature: 0.7,
      max_tokens: 50,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).choices[0].message.content).toBe("echo: Final");
  });

  it("streams OpenAI-style chunks ending with [DONE]", async () => {
    const res = await completion({ model: "chat-assistant", messages: [{ role: "user", content: "Stream me" }], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    expect(data.at(-1)).toBe("[DONE]");
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d)) as any[];
    expect(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === "chat-assistant")).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter((x) => x !== undefined).join("")).toBe("echo: Stream me");
  });

  it("requires a bearer token, like the rest of the API", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chat-assistant", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a model that is not a loaded flow", async () => {
    const res = await completion({ model: "no-such-flow", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.message).toContain("no-such-flow");
  });

  it("returns 400 with an OpenAI error envelope for a malformed request", async () => {
    const res = await completion({ model: "chat-assistant" }); // messages missing
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("messages");
  });

  it("returns 500 when a flow node fails, and names the failing node", async () => {
    const res = await completion({ model: "chat-broken", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toContain("missing");
  });
});
