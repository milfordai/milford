import { createEngine, defaultRegistry, flow, type DecideRequest } from "@milfordai/core";
import { describe, expect, it } from "vitest";
import { registerProviders } from "../src/index.js";

type Call = { url: string; headers: Record<string, string>; body: any };
/** Fake fetch that records calls and answers with `reply(call)`. */
const mock = (reply: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const recordedCall = { url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value])), body: JSON.parse(init.body as string) };
    calls.push(recordedCall);
    return new Response(JSON.stringify(reply(recordedCall)), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const build = (providers: Record<string, unknown>[], fetch: typeof globalThis.fetch, flowBuilder = flow("f")) => {
  const engine = createEngine({ registry: registerProviders(defaultRegistry()), providers: providers as any, flows: [flowBuilder.build()], fetch });
  if (!engine.ok) throw new Error(engine.error);
  return engine.value;
};
const choiceFlow = () => flow("f").node("d", "decision", { provider: "p", kind: "choice", prompt: "Which room?", options: ["kitchen", "garage"], state: "{{input.text}}" }).node("out", "output").edge("d", "out");

describe("openai", () => {
  it("chat hits /chat/completions with bearer auth", async () => {
    const mockFetch = mock(() => ({ choices: [{ message: { content: "hi" } }] }));
    const engine = build([{ id: "p", type: "openai", apiKey: "k", model: "m", baseUrl: "https://groq.test/v1" }], mockFetch.fetch, flow("f").node("l", "llm", { provider: "p", prompt: "yo" }).node("out", "output").edge("l", "out"));
    const result = await engine.run("f");
    expect(result.ok && result.value.output?.output).toBe("hi");
    expect(mockFetch.calls[0]).toMatchObject({ url: "https://groq.test/v1/chat/completions", headers: { authorization: "Bearer k" }, body: { model: "m" } });
  });
  it("decide sends a json_schema with the options and parses the answer", async () => {
    const mockFetch = mock(() => ({ choices: [{ message: { content: '{"choice":"garage","confidence":0.9}' } }] }));
    const result = await build([{ id: "p", type: "openai", model: "m" }], mockFetch.fetch, choiceFlow()).run("f", { text: "open it" });
    expect(mockFetch.calls[0]!.body.response_format.json_schema.schema.properties.choice.enum).toEqual(["kitchen", "garage", "none_of_these"]);
    expect(result.ok && result.value.output?.data).toMatchObject({ choice: "garage", confidence: 0.9 });
  });
});

describe("anthropic", () => {
  it("decide uses forced tool use", async () => {
    const mockFetch = mock(() => ({ content: [{ type: "tool_use", input: { choice: "kitchen", confidence: 0.8 } }] }));
    const result = await build([{ id: "p", type: "anthropic", apiKey: "k", model: "m" }], mockFetch.fetch, choiceFlow()).run("f", { text: "coffee" });
    expect(mockFetch.calls[0]).toMatchObject({ url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": "k" }, body: { tool_choice: { type: "tool", name: "decision" } } });
    expect(result.ok && result.value.output?.data).toMatchObject({ choice: "kitchen" });
  });
  it("chat joins text blocks", async () => {
    const mockFetch = mock(() => ({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }));
    const result = await build([{ id: "p", type: "anthropic", apiKey: "k", model: "m" }], mockFetch.fetch, flow("f").node("l", "llm", { provider: "p", prompt: "x" }).node("out", "output").edge("l", "out")).run("f");
    expect(result.ok && result.value.output?.output).toBe("ab");
  });
});

describe("typesafe", () => {
  const answers = (call: Call) => Object.fromEntries(Object.entries(call.body.questions).map(([key, question]: [string, any]) => [key, question.type === "choice" ? { type: "choice", choice: Object.keys(question.criteria)[0], probabilities: { [Object.keys(question.criteria)[0]!]: 0.9 }, confidence: 0.9 } : { type: "noul", noul: 0.7 }]));

  it("sends one Choice question and maps probabilities", async () => {
    const mockFetch = mock((call) => ({ model: "jev-latest", answers: answers(call) }));
    const result = await build([{ id: "p", type: "typesafe", apiKey: "k" }], mockFetch.fetch, choiceFlow()).run("f", { text: "hi" });
    expect(mockFetch.calls[0]).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", body: { state: "hi", model: "jev-latest", questions: { q0: { type: "choice", criteria: { kitchen: null, garage: null, none_of_these: null } } } } });
    expect(result.ok && result.value.output?.data).toMatchObject({ choice: "kitchen", probabilities: { kitchen: 0.9 } });
  });

  it("batches same-level decisions over the same state into one request", async () => {
    const mockFetch = mock((call) => ({ answers: answers(call) }));
    const batchFlow = flow("f")
      .node("a", "decision", { provider: "p", kind: "choice", prompt: "room?", options: ["kitchen"], state: "{{input.text}}" })
      .node("b", "decision", { provider: "p", kind: "noul", prompt: "urgent?", state: "{{input.text}}" });
    const result = await build([{ id: "p", type: "typesafe", apiKey: "k" }], mockFetch.fetch, batchFlow).run("f", { text: "hi" });
    expect(mockFetch.calls).toHaveLength(1);
    expect(Object.keys(mockFetch.calls[0]!.body.questions)).toEqual(["q0", "q1"]);
    expect(result.ok && result.value.ok).toBe(true);
  });
});

describe("provider swap", () => {
  // The same decision flow, only the provider config changes.
  const run = async (provider: Record<string, unknown>, reply: (call: Call) => unknown) => {
    const mockFetch = mock(reply);
    const result = await build([{ id: "p", ...provider }], mockFetch.fetch, choiceFlow()).run("f", { text: "the garage is open" });
    if (!result.ok) throw new Error(result.error);
    return { data: result.value.output?.data, calls: mockFetch.calls };
  };
  const map = { choice: "$.predictions[0].label", probabilities: "$.predictions[0].scores" };

  it("http classifier maps label and aligned score array", async () => {
    const { data, calls } = await run({ type: "http", url: "http://clf.local/predict", request: { text: "{{state}}", labels: "{{options}}" }, map }, () => ({ predictions: [{ label: "garage", scores: [0.1, 0.8, 0.1] }] }));
    expect(calls[0]!.body).toEqual({ text: "the garage is open", labels: ["kitchen", "garage", "none_of_these"] });
    expect(data).toMatchObject({ choice: "garage", confidence: 0.8, probabilities: { kitchen: 0.1, garage: 0.8 } });
  });

  it("http classifier without a choice path takes the argmax", async () => {
    const { data } = await run({ type: "http", url: "http://clf.local", map: { probabilities: "$.p" } }, () => ({ p: [0.2, 0.7, 0.1] }));
    expect(data).toMatchObject({ choice: "garage", confidence: 0.7 });
  });

  it("rejects an invalid provider config at load time", () => {
    const engine = createEngine({ registry: registerProviders(defaultRegistry()), providers: [{ id: "p", type: "anthropic" }] });
    expect(engine.ok).toBe(false);
  });
});

it("decide request type is vendor-neutral", () => {
  const request: DecideRequest = { kind: "noul", prompt: "q" };
  expect(request.kind).toBe("noul");
});
