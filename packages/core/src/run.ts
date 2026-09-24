import { canonical, sha256 } from "./cache.js";
import type { CompiledFlow } from "./compile.js";
import { ProviderHub } from "./providers.js";
import type { Registry } from "./registry.js";
import type { Cache, Condition, Node, NodeResult, NodeState, Provider, RunEvent, RunResult } from "./types.js";

export type RunDeps = { registry: Registry; providers?: Map<string, Provider>; fetch?: typeof fetch; cache?: Cache };
export type RunOptions = {
  input?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  runId?: string;
};

function check(condition: Condition, result: NodeResult): boolean {
  const value = condition.path.split(".").reduce<any>((acc, key) => acc?.[key], result);
  switch (condition.op) {
    case "eq": return value === condition.value;
    case "neq": return value !== condition.value;
    case "gt": return value > (condition.value as number);
    case "gte": return value >= (condition.value as number);
    case "lt": return value < (condition.value as number);
    case "lte": return value <= (condition.value as number);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs a compiled flow. Never throws: failures land in the per-node results. */
export async function runFlow(compiled: CompiledFlow, deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
  const runId = opts.runId ?? crypto.randomUUID();
  const emit = (event: RunEvent) => {
    try {
      opts.onEvent?.(event);
    } catch {
      // An event subscriber must not be able to fail the run it observes.
    }
  };
  const timeoutSignal = opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs);
  const runSignal = AbortSignal.any([opts.signal, timeoutSignal].filter((signal): signal is AbortSignal => !!signal));
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
    } catch (error) {
      return { success: false, error: message(error) };
    }
  };

  const execute = async (node: Node, upstream: Record<string, NodeResult>): Promise<NodeResult> => {
    // The key covers the flow, the node, its config, its upstream results and the run input: two runs with
    // different input must never share a memoized result.
    let cacheKey: string | undefined;
    if (node.cache && deps.cache) {
      try {
        cacheKey = `${compiled.flow.id}:${node.id}:${await sha256(canonical({ config: node.config, upstream, input: opts.input }))}`;
      } catch {
        cacheKey = undefined; // too deeply nested to key: run without memoization
      }
    }
    const hit = cacheKey && deps.cache!.get(cacheKey);
    if (hit) return hit;

    const signal = node.timeoutMs === undefined ? runSignal : AbortSignal.any([runSignal, AbortSignal.timeout(node.timeoutMs)]);
    const policy = node.retry;
    // `on` defaults to "infra": only failures the node type classifies as retryable.
    const on = policy?.on ?? "infra";
    const retry = (result: NodeResult) => policy !== undefined && (on === "all" || (on === "infra" && (deps.registry.nodes.get(node.type)?.retryable?.({ ...result }) ?? false)));
    const wait = (attempt: number) => {
      const base = (policy?.backoffMs ?? 200) * (policy?.multiplier ?? 2) ** (attempt - 1);
      const capped = Math.min(base, policy?.maxBackoffMs ?? Infinity);
      const jitter = policy?.jitterMs && capped > 0 ? Math.round((Math.random() * 2 - 1) * policy.jitterMs) : 0;
      return Math.max(0, capped + jitter);
    };
    const started = Date.now();
    const tries = Math.max(1, policy?.attempts ?? 1);
    let result: NodeResult = { success: false, error: signal.aborted ? "aborted" : "not run" };
    for (let index = 0; index < tries && !signal.aborted; index++) {
      if (index > 0) await sleep(wait(index), signal);
      result = await attempt(node, upstream, signal);
      if (result.success || !retry(result)) break;
      if (policy?.stopDelayMs !== undefined && Date.now() - started >= policy.stopDelayMs) break;
    }

    if (result.success && cacheKey) deps.cache!.set(cacheKey, result);
    return result;
  };

  const exec = async (node: Node) => {
    const edges = compiled.incoming.get(node.id)!;
    // An edge is live when its source finished and its condition (if any) holds.
    const live = edges.filter((edge) => {
      const from = nodes[edge.from]!;
      return from.status === "done" && (!edge.when || check(edge.when, from.result!));
    });
    if (edges.length && (node.join === "all" ? live.length < edges.length : !live.length)) {
      nodes[node.id] = { status: "skipped" };
      return emit({ type: "node:skipped", runId, nodeId: node.id });
    }

    const start = performance.now();
    emit({ type: "node:start", runId, nodeId: node.id });
    const result = await execute(node, Object.fromEntries(live.map((edge) => [edge.from, nodes[edge.from]!.result!])));
    const ms = performance.now() - start;
    if (result.success) {
      nodes[node.id] = { status: "done", result, ms };
      emit({ type: "node:done", runId, nodeId: node.id, result, ms });
    } else {
      nodes[node.id] = { status: "error", result, ms };
      emit({ type: "node:error", runId, nodeId: node.id, error: result.error ?? "unknown error", ms });
    }
  };

  for (const level of compiled.levels) await Promise.all(level.map(exec));

  const outNode = [...compiled.flow.nodes].reverse().find((node) => node.type === "output" && nodes[node.id]?.status === "done");
  return {
    ok: Object.values(nodes).every((nodeState) => nodeState.status !== "error"),
    runId,
    nodes,
    output: outNode && nodes[outNode.id]!.result,
    ...(timeoutSignal?.aborted && { timedOut: true }),
  };
}
