import type { CompiledFlow } from "./compile.js";
import { ProviderHub } from "./providers.js";
import type { Registry } from "./registry.js";
import type { Cache, Condition, Node, NodeResult, NodeState, Provider, RunEvent, RunResult } from "./types.js";

export type RunDeps = { registry: Registry; providers?: Map<string, Provider>; fetch?: typeof fetch; cache?: Cache };
export type RunOptions = {
  input?: Record<string, unknown>;
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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs a compiled flow. Never throws: failures land in the per-node results. */
export async function runFlow(compiled: CompiledFlow, deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
  const runId = opts.runId ?? crypto.randomUUID();
  const emit = (e: RunEvent) => opts.onEvent?.(e);
  const runSignal = AbortSignal.any([opts.signal, opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs)].filter((s): s is AbortSignal => !!s));
  const hub = new ProviderHub(deps.providers ?? new Map(), runId, emit);
  const nodes: Record<string, NodeState> = {};

  /** One attempt of a node: config already parsed, signal already scoped. */
  const attempt = async (node: Node, upstream: Record<string, NodeResult>, signal: AbortSignal): Promise<NodeResult> => {
    const def = deps.registry.nodes.get(node.type);
    if (!def) return { success: false, error: `no node type "${node.type}"` };
    if (signal.aborted) return { success: false, error: "aborted" };
    try {
      return await def.run(
        { runId, nodeId: node.id, input: opts.input ?? {}, config: compiled.configs.get(node.id) ?? node.config ?? {}, signal, providers: hub.access(node.id), fetch: deps.fetch ?? fetch },
        upstream,
      );
    } catch (err) {
      return { success: false, error: message(err) };
    }
  };

  const execute = async (node: Node, upstream: Record<string, NodeResult>): Promise<NodeResult> => {
    const key = node.cache && deps.cache ? `${node.type}:${JSON.stringify(node.config)}:${JSON.stringify(upstream)}` : undefined;
    const hit = key && deps.cache!.get(key);
    if (hit) return hit;
    const signal = node.timeoutMs === undefined ? runSignal : AbortSignal.any([runSignal, AbortSignal.timeout(node.timeoutMs)]);
    const tries = Math.max(1, node.retry?.attempts ?? 1);
    let result: NodeResult = { success: false, error: "not run" };
    for (let i = 0; i < tries && !signal.aborted; i++) {
      if (i > 0) await sleep((node.retry?.backoffMs ?? 200) * 2 ** (i - 1), signal);
      result = await attempt(node, upstream, signal);
      if (result.success) break;
    }
    if (result.success && key) deps.cache!.set(key, result);
    return result;
  };

  const exec = async (node: Node) => {
    const edges = compiled.incoming.get(node.id)!;
    // An edge is live when its source finished and its condition (if any) holds.
    const live = edges.filter((e) => {
      const from = nodes[e.from]!;
      return from.status === "done" && (!e.when || check(e.when, from.result!));
    });
    if (edges.length && (node.join === "all" ? live.length < edges.length : !live.length)) {
      nodes[node.id] = { status: "skipped" };
      return emit({ type: "node:skipped", runId, nodeId: node.id });
    }
    const start = performance.now();
    emit({ type: "node:start", runId, nodeId: node.id });
    const result = await execute(node, Object.fromEntries(live.map((e) => [e.from, nodes[e.from]!.result!])));
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

  const outNode = [...compiled.flow.nodes].reverse().find((n) => n.type === "output" && nodes[n.id]?.status === "done");
  return {
    ok: Object.values(nodes).every((n) => n.status !== "error"),
    runId,
    nodes,
    output: outNode && nodes[outNode.id]!.result,
  };
}
