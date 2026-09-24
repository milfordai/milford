export const helloFlow = {
  id: "hello",
  nodes: [
    { id: "in", type: "input" },
    { id: "greet", type: "prompt", config: { template: "Hello {{input.name}}!" } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "greet" },
    { from: "greet", to: "out" },
  ],
};

export const decisionFlow = {
  id: "decide",
  nodes: [
    { id: "in", type: "input" },
    { id: "d", type: "decision", config: { provider: "fake", kind: "choice", prompt: "Rate the sentiment", options: ["positive", "negative"], minConfidence: 0.5 } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "d" },
    { from: "d", to: "out" },
  ],
};

/** First provider call fails (HTTP 500) so the `llm` node retries and the second succeeds. */
export const retryFlow = {
  id: "retry",
  nodes: [
    { id: "in", type: "input" },
    { id: "llm", type: "llm", config: { provider: "fake", prompt: "Say hi" }, retry: { attempts: 2, backoffMs: 5 } },
    { id: "out", type: "output", config: { template: "{{llm.output}}" } },
  ],
  edges: [
    { from: "in", to: "llm" },
    { from: "llm", to: "out" },
  ],
};

export const cacheFlow = {
  id: "cached",
  cache: { mode: "direct", ttlMs: 600_000 },
  nodes: [
    { id: "in", type: "input" },
    { id: "g", type: "prompt", config: { template: "Ran {{input.n}}" } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "g" },
    { from: "g", to: "out" },
  ],
};

/** Two branches from one prompt node; `join: all` requires both to be live. */
export const branchedFlow = {
  id: "branched",
  nodes: [
    { id: "in", type: "input" },
    { id: "prompt", type: "prompt", config: { template: "V {{input.v}}" } },
    { id: "a", type: "prompt", config: { template: "A" } },
    { id: "b", type: "prompt", config: { template: "B" } },
    { id: "join", type: "prompt", config: { template: "{{a.output}}-{{b.output}}" }, join: "all" },
    { id: "out", type: "output", config: { template: "{{join.output}}" } },
  ],
  edges: [
    { from: "in", to: "prompt" },
    { from: "prompt", to: "a", when: { path: "output", op: "eq", value: "V yes" } },
    { from: "prompt", to: "b", when: { path: "output", op: "eq", value: "V no" } },
    { from: "a", to: "join" },
    { from: "b", to: "join" },
  ],
};

export const unknownTemplateFlow = {
  id: "unknown-template",
  nodes: [
    { id: "in", type: "input" },
    { id: "boom", type: "prompt", config: { template: "{{missing.variable}}" } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "boom" },
    { from: "boom", to: "out" },
  ],
};

export const cycleFlow = {
  id: "cycle",
  nodes: [
    { id: "a", type: "prompt", config: { template: "A" } },
    { id: "b", type: "prompt", config: { template: "B" } },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ],
};

/** A chat flow that sends one templated prompt to the given provider. */
export const llmFlow = (id: string, providerId: string, prompt: string, retry?: object) => ({
  id,
  nodes: [
    { id: "in", type: "input" },
    { id: "llm", type: "llm", config: { provider: providerId, prompt }, ...(retry ? { retry } : {}) },
    { id: "out", type: "output", config: { template: "{{llm.output}}" } },
  ],
  edges: [
    { from: "in", to: "llm" },
    { from: "llm", to: "out" },
  ],
});

/** Two chat calls issued in the same tick, so a per-provider rate limit must space them. */
export const parallelLlmFlow = (id: string, providerId: string) => ({
  id,
  nodes: [
    { id: "in", type: "input" },
    { id: "a", type: "llm", config: { provider: providerId, prompt: `Call A on ${id}` } },
    { id: "b", type: "llm", config: { provider: providerId, prompt: `Call B on ${id}` } },
    { id: "out", type: "output", config: { template: "{{a.output}}|{{b.output}}" }, join: "all" },
  ],
  edges: [
    { from: "in", to: "a" },
    { from: "in", to: "b" },
    { from: "a", to: "out" },
    { from: "b", to: "out" },
  ],
});

/** `count` decisions issued in the same tick, so a provider with `decideMany` batches them. */
export const parallelDecisionFlow = (id: string, providerId: string, count: number) => ({
  id,
  nodes: [
    { id: "in", type: "input" },
    ...Array.from({ length: count }, (_, index) => ({
      id: `d${index}`,
      type: "decision",
      config: { provider: providerId, kind: "choice", prompt: `Rate option number ${index}`, options: ["positive", "negative"] },
    })),
    {
      id: "out",
      type: "output",
      config: { template: Array.from({ length: count }, (_, index) => `{{d${index}.output}}`).join("|") },
      join: "all" as const,
    },
  ],
  edges: [
    ...Array.from({ length: count }, (_, index) => ({ from: "in", to: `d${index}` })),
    ...Array.from({ length: count }, (_, index) => ({ from: `d${index}`, to: "out" })),
  ],
});

/** A prompt flow with a description and a typed input, as MCP tools describe them. */
export const greetFlow = {
  id: "greet",
  description: "Greet a person by name.",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  nodes: [
    { id: "in", type: "input" },
    { id: "greet", type: "prompt", config: { template: "Hello {{input.name}}!" } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "greet" },
    { from: "greet", to: "out" },
  ],
};

/** A flow whose node always fails, for error results. */
export const boomFlow = {
  id: "boom",
  description: "Always fails.",
  nodes: [
    { id: "in", type: "input" },
    { id: "boom", type: "prompt", config: { template: "{{input.not.there}}" } },
    { id: "out", type: "output" },
  ],
  edges: [
    { from: "in", to: "boom" },
    { from: "boom", to: "out" },
  ],
};
