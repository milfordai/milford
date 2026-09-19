export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
/** Branch condition, evaluated on the upstream node's NodeResult, e.g. path "data.choice". */
export type Condition = { path: string; op: Op; value: unknown };

export type Node = {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  /** "any" (default): runs when at least one incoming edge is live. "all": every incoming edge must be live. */
  join?: "any" | "all";
  retry?: { attempts: number; backoffMs?: number };
  timeoutMs?: number;
  /** Memoize successful results by (type, config, upstream). */
  cache?: boolean;
  /** Opaque to the engine; an editor can keep layout here. */
  meta?: unknown;
};
export type Edge = { from: string; to: string; when?: Condition };
export type Flow = { id: string; nodes: Node[]; edges: Edge[] };

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
  chat?(req: ChatRequest): Promise<Result<{ text: string }>>;
  decide?(req: DecideRequest): Promise<Result<Decision>>;
  /** Optional batching; core falls back to parallel `decide`. */
  decideMany?(reqs: DecideRequest[]): Promise<Result<Decision[]>>;
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
  chat(id: string, req: ChatRequest): Promise<Result<{ text: string }>>;
  decide(id: string, req: DecideRequest): Promise<Result<Decision>>;
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
