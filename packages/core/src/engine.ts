import { compileFlow, type CompiledFlow, type ProviderCaps } from "./compile.js";
import { lruCache } from "./cache.js";
import { withFallback } from "./providers.js";
import { withBreaker, withRateLimit } from "./resilience.js";
import type { Registry } from "./registry.js";
import { runFlow, type RunOptions } from "./run.js";
import type { Flow, Provider, ProviderConfig, Result, RunResult } from "./types.js";

/** The `error` of a run rejected by `maxConcurrentRuns`. Callers can map it to their own "busy" response. */
export const TOO_MANY_RUNS = "too many concurrent runs";

export type EngineConfig = {
  registry: Registry;
  providers?: ProviderConfig[];
  flows?: Flow[];
  fetch?: typeof fetch;
  /** Runs allowed at once. Further runs are rejected with `TOO_MANY_RUNS`. Unlimited by default. */
  maxConcurrentRuns?: number;
  /** Default per-run timeout in milliseconds, unless a run passes its own. */
  timeoutMs?: number;
};

export type Engine = {
  flows(): { id: string; nodes: number; description?: string; input?: Record<string, unknown> }[];
  run(flowId: string, input?: Record<string, unknown>, opts?: Omit<RunOptions, "input">): Promise<Result<RunResult>>;
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
  for (const f of cfg.flows ?? []) {
    const c = compileFlow(f, cfg.registry, caps);
    if (!c.ok) return { ok: false, error: `flow "${f.id}": ${c.error}` };
    compiled.set(f.id, c.value);
  }

  const cache = lruCache();
  let active = 0;
  return {
    ok: true,
    value: {
      flows: () => [...compiled.values()].map(({ flow: f }) => ({ id: f.id, nodes: f.nodes.length, description: f.description, input: f.input })),
      async run(flowId, input = {}, opts = {}) {
        const c = compiled.get(flowId);
        if (!c) return { ok: false, error: `unknown flow "${flowId}"` };
        if (active >= (cfg.maxConcurrentRuns ?? Infinity)) return { ok: false, error: TOO_MANY_RUNS };
        active++;
        try {
          return { ok: true, value: await runFlow(c, { registry: cfg.registry, providers, fetch: doFetch, cache }, { ...opts, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs, input }) };
        } finally {
          active--;
        }
      },
    },
  };
}
