import type { CompiledFlow } from "./compile.js";
import type { Condition, Node, NodeResult, NodeRunner, NodeState, RunEvent, RunResult } from "./types.js";

export type RunOptions = {
  input?: Record<string, unknown>;
  runners: Record<string, NodeRunner>;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
  runId?: string;
};

function check(c: Condition, result: NodeResult): boolean {
  const v = c.path.split(".").reduce<any>((o, k) => o?.[k], result);
  switch (c.op) {
    case "eq": return v === c.value;
    case "neq": return v !== c.value;
    case "gt": return v > (c.value as number);
    case "gte": return v >= (c.value as number);
    case "lt": return v < (c.value as number);
    case "lte": return v <= (c.value as number);
  }
}

/** Runs a compiled flow. Never throws: failures land in the per-node results. */
export async function runFlow(compiled: CompiledFlow, opts: RunOptions): Promise<RunResult> {
  const runId = opts.runId ?? crypto.randomUUID();
  const emit = (e: RunEvent) => opts.onEvent?.(e);
  const signals = [opts.signal, opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs)];
  const signal = AbortSignal.any(signals.filter((s): s is AbortSignal => !!s));
  const nodes: Record<string, NodeState> = {};

  const exec = async (node: Node) => {
    const edges = compiled.incoming.get(node.id)!;
    // An edge is live when its source finished and its condition (if any) holds.
    const live = edges.filter((e) => {
      const from = nodes[e.from]!;
      return from.status === "done" && (!e.when || check(e.when, from.result!));
    });
    if (edges.length && !live.length) {
      nodes[node.id] = { status: "skipped" };
      return emit({ type: "node:skipped", runId, nodeId: node.id });
    }
    const runner = opts.runners[node.type];
    const start = performance.now();
    emit({ type: "node:start", runId, nodeId: node.id });
    let result: NodeResult;
    try {
      if (!runner) throw new Error(`no runner for node type "${node.type}"`);
      if (signal.aborted) throw new Error("aborted");
      const upstream = Object.fromEntries(live.map((e) => [e.from, nodes[e.from]!.result!]));
      result = await runner({ runId, input: opts.input ?? {}, config: node.config ?? {}, signal }, upstream);
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const ms = performance.now() - start;
    if (result.success) {
      nodes[node.id] = { status: "done", result, ms };
      emit({ type: "node:done", runId, nodeId: node.id, result, ms });
    } else {
      nodes[node.id] = { status: "error", result, ms };
      emit({ type: "node:error", runId, nodeId: node.id, error: result.error ?? "unknown error", ms });
    }
  };

  const limit = Math.max(1, opts.concurrency ?? Infinity);
  for (const level of compiled.levels) {
    const queue = [...level];
    const worker = async () => { for (let n = queue.shift(); n; n = queue.shift()) await exec(n); };
    await Promise.all(Array.from({ length: Math.min(limit, level.length) }, worker));
  }
  return { ok: Object.values(nodes).every((n) => n.status !== "error"), runId, nodes };
}
