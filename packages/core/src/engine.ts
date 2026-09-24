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
export function createEngine(config: EngineConfig): Result<Engine> {
  const doFetch = config.fetch ?? fetch;
  const providers = new Map<string, Provider>();
  for (const providerConfig of config.providers ?? []) {
    if (providers.has(providerConfig.id)) return { ok: false, error: `duplicate provider id "${providerConfig.id}"` };

    const factory = config.registry.providerTypes.get(providerConfig.type);
    if (!factory) return { ok: false, error: `provider "${providerConfig.id}": unknown type "${providerConfig.type}"` };

    const result = factory(providerConfig, { fetch: doFetch });
    if (!result.ok) return { ok: false, error: `provider "${providerConfig.id}": ${result.error}` };

    // Rate limit innermost, breaker outside it, so a tripped circuit fails fast without queueing.
    let provider = result.value;
    if (providerConfig.rateLimit) provider = withRateLimit(provider, providerConfig.rateLimit);
    if (providerConfig.circuitBreaker) provider = withBreaker(provider, providerConfig.circuitBreaker);
    providers.set(providerConfig.id, provider);
  }

  // Detect cycles in the provider fallback graph by walking every fallback path.
  const hasCycle = (startProviderId: string): boolean => {
    const visit = (providerId: string, seen: Set<string>): boolean => {
      if (seen.has(providerId)) return true;

      seen.add(providerId);

      const providerConfig = config.providers?.find((provider) => provider.id === providerId);

      for (const fallbackId of providerConfig?.fallback ?? []) {
        if (visit(fallbackId, new Set(seen))) return true;
      }

      return false;
    };

    return visit(startProviderId, new Set());
  };

  for (const providerConfig of config.providers ?? []) {
    if (!providerConfig.fallback?.length) continue;

    const fallbacks: Provider[] = [];

    for (const fallbackId of providerConfig.fallback) {
      const provider = providers.get(fallbackId);

      if (!provider) return { ok: false, error: `provider "${providerConfig.id}": unknown fallback "${fallbackId}"` };

      fallbacks.push(provider);
    }

    if (hasCycle(providerConfig.id)) return { ok: false, error: `provider "${providerConfig.id}": fallback cycle detected` };

    providers.set(providerConfig.id, withFallback(providers.get(providerConfig.id)!, fallbacks));
  }

  const caps: ProviderCaps = new Map([...providers].map(([providerId, provider]) => [providerId, provider.capabilities]));
  const compiled = new Map<string, CompiledFlow>();
  const inputs = new Map<string, z.ZodType>();
  for (const flow of config.flows ?? []) {
    const result = compileFlow(flow, config.registry, caps);
    if (!result.ok) return { ok: false, error: `flow "${flow.id}": ${result.error}` };

    compiled.set(flow.id, result.value);

    if (flow.input) {
      try {
        inputs.set(flow.id, z.fromJSONSchema(flow.input as z.core.JSONSchema.JSONSchema));
      } catch (error) {
        return { ok: false, error: `flow "${flow.id}": input is not a valid JSON Schema: ${(error as Error).message}` };
      }
    }
  }

  const cache = lruCache();
  const runCache = config.runCache ?? memoryRunCache();
  // What a cached result depends on besides the input: the flow and the provider config (which model, which prompt).
  const versions = new Map<string, Promise<string>>();
  const version = (flow: Flow) => versions.get(flow.id) ?? versions.set(flow.id, sha256(canonical({ flow, providers: config.providers ?? [] }))).get(flow.id)!;
  let active = 0;
  return {
    ok: true,
    value: {
      flows: () => [...compiled.values()].map(({ flow }) => ({ id: flow.id, nodes: flow.nodes.length, description: flow.description, input: flow.input })),
      async run(flowId, input = {}, opts = {}) {
        const compiledFlow = compiled.get(flowId);
        if (!compiledFlow) return { ok: false, error: `unknown flow "${flowId}"` };

        const parsed = inputs.get(flowId)?.safeParse(input);
        if (parsed && !parsed.success) {
          return { ok: false, error: `${INVALID_INPUT}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}` };
        }

        const cachePolicy = compiledFlow.flow.cache;
        const useCache = cachePolicy && !opts.onEvent && opts.cache !== "off";
        const cacheKey = useCache ? `${flowId}:${await version(compiledFlow.flow)}:${await sha256(canonical(input))}` : undefined;

        // A hit skips the run, so it does not count against maxConcurrentRuns.
        if (cacheKey && opts.cache !== "refresh") {
          const hit = await runCache.get(cacheKey);
          if (hit) return { ok: true, value: { ...hit, cache: "hit" } };
        }

        if (active >= (config.maxConcurrentRuns ?? Infinity)) return { ok: false, error: TOO_MANY_RUNS };
        active++;

        try {
          const { cache: _ignored, ...run } = opts;
          const result = await runFlow(compiledFlow, { registry: config.registry, providers, fetch: doFetch, cache }, { ...run, timeoutMs: opts.timeoutMs ?? config.timeoutMs, input });

          // Only successful runs are kept, so a failure is retried instead of replayed.
          if (cacheKey && result.ok) await runCache.set(cacheKey, result, cachePolicy!.ttlMs);

          return { ok: true, value: cachePolicy ? { ...result, cache: "miss" } : result };
        } finally {
          active--;
        }
      },
    },
  };
}
