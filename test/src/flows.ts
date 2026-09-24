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
