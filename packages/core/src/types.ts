export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
/** Branch condition, evaluated on the upstream node's NodeResult, e.g. path "data.choice". */
export type Condition = { path: string; op: Op; value: unknown };

/** Retry policy of a node. Mirrors tenacity: `attempts`/`stopDelayMs` stop, `backoffMs`/`multiplier` wait. */
export type RetryPolicy = {
  /** Most attempts, including the first. Same as tenacity's `stop_after_attempt`. */
  attempts: number;
  /** Wait before the second attempt; doubles by `multiplier`, capped at `maxBackoffMs`. Same as tenacity's `wait_exponential`. */
  backoffMs?: number;
  /** Backoff multiplier; defaults to 2, matching the old behaviour. */
  multiplier?: number;
  /** Upper bound on each backoff wait. */
  maxBackoffMs?: number;
  /** Random plus/minus to add to each backoff wait, to scatter retries. */
  jitterMs?: number;
  /** Stop trying once this many milliseconds have passed since the first attempt. Same as tenacity's `stop_after_delay`. */
  stopDelayMs?: number;
  /**
   * Which failures are retried. `infra` (default) retries failures the node type classifies as retryable
   * (declared through its `retryable` hook); `all` retries every failure; `none` never retries.
   */
  on?: "infra" | "all" | "none";
};

export type Node = {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  /** "any" (default): runs when at least one incoming edge is live. "all": every incoming edge must be live. */
  join?: "any" | "all";
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** Memoize successful results by (type, config, upstream). */
  cache?: boolean;
  /** Opaque to the engine; an editor can keep layout here. */
  meta?: unknown;
};
export type Edge = { from: string; to: string; when?: Condition };
export type Flow = {
  id: string;
  /** What the flow does. Shown to callers such as MCP clients. */
  description?: string;
  /** JSON Schema of the run input, for callers that need to describe it. The engine does not enforce it. */
  input?: Record<string, unknown>;
  /**
   * Reuse the result of an earlier identical run instead of running the flow again. Off by default: only
   * cache flows that are deterministic and have no side effects, because a hit skips every node.
   */
  cache?: { mode: "direct"; ttlMs: number };
  nodes: Node[];
  edges: Edge[];
};

export type NodeResult = { success: boolean; output?: string; data?: unknown; error?: string };

export type NodeStatus = "done" | "error" | "skipped";
export type NodeState = { status: NodeStatus; result?: NodeResult; ms?: number };

export type RunEvent =
  | { type: "node:start"; runId: string; nodeId: string }
  | { type: "node:done"; runId: string; nodeId: string; result: NodeResult; ms: number }
  | { type: "node:error"; runId: string; nodeId: string; error: string; ms: number }
  | { type: "node:skipped"; runId: string; nodeId: string }
  | { type: "provider:call"; runId: string; nodeId: string; provider: string; capability: Capability; ok: boolean; ms: number };

export type RunResult = {
  ok: boolean;
  runId: string;
  nodes: Record<string, NodeState>;
  /** Result of the flow's `output` node, when one ran. */
  output?: NodeResult;
  /** Only for flows with `cache`: `hit` is an earlier run's result (its `runId` and trace), `miss` a run that executed. */
  cache?: "hit" | "miss";
};

// --- Provider port -------------------------------------------------------

export type Capability = "chat" | "decide";
export type DecisionKind = "choice" | "score" | "noul";

export type ChatRequest = { prompt: string; system?: string; model?: string; signal?: AbortSignal };
/** `options` are the choices for `choice` and the ordered levels for `score`. */
export type DecideRequest = { kind: DecisionKind; prompt: string; state?: unknown; options?: string[]; model?: string; signal?: AbortSignal };
export type Decision = {
  kind: DecisionKind;
  choice?: string;
  /** Position between levels, 0..levels-1. */
  score?: number;
  /** Probability that a noul answer is yes. */
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export interface Provider {
  id: string;
  type: string;
  capabilities: Capability[];
  chat?(request: ChatRequest): Promise<Result<{ text: string }>>;
  decide?(request: DecideRequest): Promise<Result<Decision>>;
  /** Optional batching; core falls back to parallel `decide`. */
  decideMany?(requests: DecideRequest[]): Promise<Result<Decision[]>>;
}

export type ProviderConfig = {
  id: string;
  type: string;
  fallback?: string[];
  /** Fail fast after repeated errors so `fallback` takes over. */
  circuitBreaker?: { failures: number; resetMs: number };
  /** Cap outgoing calls; callers wait their turn. */
  rateLimit?: { perSecond: number; burst?: number };
  [key: string]: unknown;
};
export type ProviderFactory = (config: ProviderConfig, deps: { fetch: typeof fetch }) => Result<Provider>;

export type ProviderAccess = {
  chat(id: string, request: ChatRequest): Promise<Result<{ text: string }>>;
  decide(id: string, request: DecideRequest): Promise<Result<Decision>>;
};

// --- Nodes ---------------------------------------------------------------

export type NodeContext<C = Record<string, unknown>> = {
  runId: string;
  nodeId: string;
  input: Record<string, unknown>;
  config: C;
  signal: AbortSignal;
  providers: ProviderAccess;
  fetch: typeof fetch;
};

export interface Cache {
  get(key: string): NodeResult | undefined;
  set(key: string, value: NodeResult): void;
}
