import { z } from "zod";
import { compileFlow, type CompiledFlow, type ProviderCaps } from "./compile.js";
import { canonical, lruCache, memoryRunCache, sha256, type RunCache } from "./cache.js";
import { withFallback } from "./providers.js";
import { withBreaker, withRateLimit } from "./resilience.js";
import type { Registry } from "./registry.js";
import { runFlow, type RunOptions } from "./run.js";
import type { Flow, Provider, ProviderConfig, Result, RunResult } from "./types.js";

/** The `error` of a run rejected by `maxConcurrentRuns`. Callers can map it to their own "busy" response. */
export const TOO_MANY_RUNS = "too many concurrent runs";
/** Prefix of the `error` of a run whose input does not match the flow's declared `input` JSON Schema. */
export const INVALID_INPUT = "invalid input";

export type EngineConfig = {
  registry: Registry;
  providers?: ProviderConfig[];
  flows?: Flow[];
  fetch?: typeof fetch;
  /** Runs allowed at once. Further runs are rejected with `TOO_MANY_RUNS`. Unlimited by default. */
  maxConcurrentRuns?: number;
  /** Default per-run timeout in milliseconds, unless a run passes its own. */
  timeoutMs?: number;
  /** Where finished runs of flows with `cache` are kept. In memory by default. */
  runCache?: RunCache;
};

/**
 * `cache: "refresh"` skips the lookup but stores the fresh result (HTTP `Cache-Control: no-cache`).
 * `cache: "off"` neither reads nor writes (`no-store`). Runs that stream events never use the cache.
 */
export type EngineRunOptions = Omit<RunOptions, "input"> & { cache?: "refresh" | "off" };

export type Engine = {
  flows(): { id: string; nodes: number; description?: string; input?: Record<string, unknown> }[];
  run(flowId: string, input?: Record<string, unknown>, opts?: EngineRunOptions): Promise<Result<RunResult>>;
};

/** Builds providers, compiles every flow once (failing fast on bad config), and returns a runner. */
export function createEngine(cfg: EngineConfig): Result<Engine> {
  const doFetch = cfg.fetch ?? fetch;
  const providers = new Map<string, Provider>();
  for (const pc of cfg.providers ?? []) {
    if (providers.has(pc.id)) return { ok: false, error: `duplicate provider id "${pc.id}"` };
    const factory = cfg.registry.providerTypes.get(pc.type);
    if (!factory) return { ok: false, error: `provider "${pc.id}": unknown type "${pc.type}"` };
    const p = factory(pc, { fetch: doFetch });
    if (!p.ok) return { ok: false, error: `provider "${pc.id}": ${p.error}` };
    // Rate limit innermost, breaker outside it, so a tripped circuit fails fast without queueing.
    let wrapped = p.value;
    if (pc.rateLimit) wrapped = withRateLimit(wrapped, pc.rateLimit);
    if (pc.circuitBreaker) wrapped = withBreaker(wrapped, pc.circuitBreaker);
    providers.set(pc.id, wrapped);
  }
  for (const pc of cfg.providers ?? []) {
    if (!pc.fallback?.length) continue;
    const fb: Provider[] = [];
    for (const id of pc.fallback) {
      const p = providers.get(id);
      if (!p) return { ok: false, error: `provider "${pc.id}": unknown fallback "${id}"` };
      fb.push(p);
    }
    providers.set(pc.id, withFallback(providers.get(pc.id)!, fb));
  }

  const caps: ProviderCaps = new Map([...providers].map(([id, p]) => [id, p.capabilities]));
  const compiled = new Map<string, CompiledFlow>();
  const inputs = new Map<string, z.ZodType>();
  for (const f of cfg.flows ?? []) {
    const c = compileFlow(f, cfg.registry, caps);
    if (!c.ok) return { ok: false, error: `flow "${f.id}": ${c.error}` };
    compiled.set(f.id, c.value);
    if (f.input) {
      try {
        inputs.set(f.id, z.fromJSONSchema(f.input as z.core.JSONSchema.JSONSchema));
      } catch (e) {
        return { ok: false, error: `flow "${f.id}": input is not a valid JSON Schema: ${(e as Error).message}` };
      }
    }
  }

  const cache = lruCache();
  const runCache = cfg.runCache ?? memoryRunCache();
  // What a cached result depends on besides the input: the flow and the provider config (which model, which prompt).
  const versions = new Map<string, Promise<string>>();
  const version = (f: Flow) => versions.get(f.id) ?? versions.set(f.id, sha256(canonical({ flow: f, providers: cfg.providers ?? [] }))).get(f.id)!;
  let active = 0;
  return {
    ok: true,
    value: {
      flows: () => [...compiled.values()].map(({ flow: f }) => ({ id: f.id, nodes: f.nodes.length, description: f.description, input: f.input })),
      async run(flowId, input = {}, opts = {}) {
        const c = compiled.get(flowId);
        if (!c) return { ok: false, error: `unknown flow "${flowId}"` };
        const bad = inputs.get(flowId)?.safeParse(input);
        if (bad && !bad.success) return { ok: false, error: `${INVALID_INPUT}: ${bad.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` };
        const policy = c.flow.cache;
        const useCache = policy && !opts.onEvent && opts.cache !== "off";
        const key = useCache ? `${flowId}:${await version(c.flow)}:${await sha256(canonical(input))}` : undefined;
        // A hit skips the run, so it does not count against maxConcurrentRuns.
        if (key && opts.cache !== "refresh") {
          const hit = await runCache.get(key);
          if (hit) return { ok: true, value: { ...hit, cache: "hit" } };
        }
        if (active >= (cfg.maxConcurrentRuns ?? Infinity)) return { ok: false, error: TOO_MANY_RUNS };
        active++;
        try {
          const { cache: _ignored, ...run } = opts;
          const value = await runFlow(c, { registry: cfg.registry, providers, fetch: doFetch, cache }, { ...run, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs, input });
          // Only successful runs are kept, so a failure is retried instead of replayed.
          if (key && value.ok) await runCache.set(key, value, policy!.ttlMs);
          return { ok: true, value: policy ? { ...value, cache: "miss" } : value };
        } finally {
          active--;
        }
      },
    },
  };
}
