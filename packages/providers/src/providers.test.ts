import { createEngine, defaultRegistry, flow, type DecideRequest } from "@loage/core";
import { describe, expect, it } from "vitest";
import { registerProviders } from "./index.js";

type Call = { url: string; headers: Record<string, string>; body: any };
/** Fake fetch that records calls and answers with `reply(call)`. */
const mock = (reply: (c: Call) => unknown) => {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: JSON.parse(init.body as string) };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const build = (providers: Record<string, unknown>[], fetch: typeof globalThis.fetch, f = flow("f")) => {
  const e = createEngine({ registry: registerProviders(defaultRegistry()), providers: providers as any, flows: [f.build()], fetch });
  if (!e.ok) throw new Error(e.error);
  return e.value;
};
const choiceFlow = () => flow("f").node("d", "decision", { provider: "p", kind: "choice", prompt: "Which room?", options: ["kitchen", "garage"], state: "{{input.text}}" }).node("out", "output").edge("d", "out");

describe("openai", () => {
  it("chat hits /chat/completions with bearer auth", async () => {
    const m = mock(() => ({ choices: [{ message: { content: "hi" } }] }));
    const e = build([{ id: "p", type: "openai", apiKey: "k", model: "m", baseUrl: "https://groq.test/v1" }], m.fetch, flow("f").node("l", "llm", { provider: "p", prompt: "yo" }).node("out", "output").edge("l", "out"));
    const r = await e.run("f");
    expect(r.ok && r.value.output?.output).toBe("hi");
    expect(m.calls[0]).toMatchObject({ url: "https://groq.test/v1/chat/completions", headers: { authorization: "Bearer k" }, body: { model: "m" } });
  });
  it("decide sends a json_schema with the options and parses the answer", async () => {
    const m = mock(() => ({ choices: [{ message: { content: '{"choice":"garage","confidence":0.9}' } }] }));
    const r = await build([{ id: "p", type: "openai", model: "m" }], m.fetch, choiceFlow()).run("f", { text: "open it" });
    expect(m.calls[0]!.body.response_format.json_schema.schema.properties.choice.enum).toEqual(["kitchen", "garage", "none_of_these"]);
    expect(r.ok && r.value.output?.data).toMatchObject({ choice: "garage", confidence: 0.9 });
  });
});

describe("anthropic", () => {
  it("decide uses forced tool use", async () => {
    const m = mock(() => ({ content: [{ type: "tool_use", input: { choice: "kitchen", confidence: 0.8 } }] }));
    const r = await build([{ id: "p", type: "anthropic", apiKey: "k", model: "m" }], m.fetch, choiceFlow()).run("f", { text: "coffee" });
    expect(m.calls[0]).toMatchObject({ url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": "k" }, body: { tool_choice: { type: "tool", name: "decision" } } });
    expect(r.ok && r.value.output?.data).toMatchObject({ choice: "kitchen" });
  });
  it("chat joins text blocks", async () => {
    const m = mock(() => ({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }));
    const r = await build([{ id: "p", type: "anthropic", apiKey: "k", model: "m" }], m.fetch, flow("f").node("l", "llm", { provider: "p", prompt: "x" }).node("out", "output").edge("l", "out")).run("f");
    expect(r.ok && r.value.output?.output).toBe("ab");
  });
});

describe("typesafe", () => {
  const answers = (c: Call) => Object.fromEntries(Object.entries(c.body.questions).map(([k, q]: [string, any]) => [k, q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]!]: 0.9 }, confidence: 0.9 } : { type: "noul", noul: 0.7 }]));

  it("sends one Choice question and maps probabilities", async () => {
    const m = mock((c) => ({ model: "jev-latest", answers: answers(c) }));
    const r = await build([{ id: "p", type: "typesafe", apiKey: "k" }], m.fetch, choiceFlow()).run("f", { text: "hi" });
    expect(m.calls[0]).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", body: { state: "hi", model: "jev-latest", questions: { q0: { type: "choice", criteria: { kitchen: null, garage: null, none_of_these: null } } } } });
    expect(r.ok && r.value.output?.data).toMatchObject({ choice: "kitchen", probabilities: { kitchen: 0.9 } });
  });

  it("batches same-level decisions over the same state into one request", async () => {
    const m = mock((c) => ({ answers: answers(c) }));
    const f = flow("f")
      .node("a", "decision", { provider: "p", kind: "choice", prompt: "room?", options: ["kitchen"], state: "{{input.text}}" })
      .node("b", "decision", { provider: "p", kind: "noul", prompt: "urgent?", state: "{{input.text}}" });
    const r = await build([{ id: "p", type: "typesafe", apiKey: "k" }], m.fetch, f).run("f", { text: "hi" });
    expect(m.calls).toHaveLength(1);
    expect(Object.keys(m.calls[0]!.body.questions)).toEqual(["q0", "q1"]);
    expect(r.ok && r.value.ok).toBe(true);
  });
});

describe("provider swap", () => {
  // The same decision flow, only the provider config changes.
  const run = async (provider: Record<string, unknown>, reply: (c: Call) => unknown) => {
    const m = mock(reply);
    const r = await build([{ id: "p", ...provider }], m.fetch, choiceFlow()).run("f", { text: "the garage is open" });
    if (!r.ok) throw new Error(r.error);
    return { data: r.value.output?.data, calls: m.calls };
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
    const e = createEngine({ registry: registerProviders(defaultRegistry()), providers: [{ id: "p", type: "anthropic" }] });
    expect(e.ok).toBe(false);
  });
});

it("decide request type is vendor-neutral", () => {
  const r: DecideRequest = { kind: "noul", prompt: "q" };
  expect(r.kind).toBe("noul");
});
