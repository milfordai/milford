import { compileFlow, type CompiledFlow, type ProviderCaps } from "./compile.js";
import { lruCache } from "./cache.js";
import { withFallback } from "./providers.js";
import type { Registry } from "./registry.js";
import { runFlow, type RunOptions } from "./run.js";
import type { Cache, Flow, Provider, ProviderConfig, Result, RunResult } from "./types.js";

export type EngineConfig = {
  registry: Registry;
  providers?: ProviderConfig[];
  flows?: Flow[];
  fetch?: typeof fetch;
  cache?: Cache;
};

export type Engine = {
  flows(): { id: string; nodes: number }[];
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
    providers.set(pc.id, p.value);
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

  const cache = cfg.cache ?? lruCache();
  return {
    ok: true,
    value: {
      flows: () => [...compiled.values()].map((c) => ({ id: c.flow.id, nodes: c.flow.nodes.length })),
      async run(flowId, input = {}, opts = {}) {
        const c = compiled.get(flowId);
        if (!c) return { ok: false, error: `unknown flow "${flowId}"` };
        return { ok: true, value: await runFlow(c, { registry: cfg.registry, providers, fetch: doFetch, cache }, { ...opts, input }) };
      },
    },
  };
}
