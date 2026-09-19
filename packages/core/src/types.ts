export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
/** Branch condition, evaluated on the upstream node's NodeResult, e.g. path "data.choice". */
export type Condition = { path: string; op: Op; value: unknown };

export type Node = { id: string; type: string; config?: Record<string, unknown>; meta?: unknown };
export type Edge = { from: string; to: string; when?: Condition };
export type Flow = { id: string; nodes: Node[]; edges: Edge[] };

export type NodeResult = { success: boolean; output?: string; data?: unknown; error?: string };
export type NodeContext = { runId: string; input: Record<string, unknown>; config: Record<string, unknown>; signal: AbortSignal };
export type NodeRunner = (ctx: NodeContext, upstream: Record<string, NodeResult>) => Promise<NodeResult>;

export type NodeStatus = "done" | "error" | "skipped";
export type NodeState = { status: NodeStatus; result?: NodeResult; ms?: number };

export type RunEvent =
  | { type: "node:start"; runId: string; nodeId: string }
  | { type: "node:done"; runId: string; nodeId: string; result: NodeResult; ms: number }
  | { type: "node:error"; runId: string; nodeId: string; error: string; ms: number }
  | { type: "node:skipped"; runId: string; nodeId: string };

export type RunResult = { ok: boolean; runId: string; nodes: Record<string, NodeState> };
