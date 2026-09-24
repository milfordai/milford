import type { Capability, ChatRequest, DecideRequest, Decision, Provider, ProviderAccess, Result, RunEvent } from "./types.js";

/** Composite provider: tries `primary`, then each fallback in order. */
export function withFallback(primary: Provider, fallbacks: Provider[]): Provider {
  const chain = [primary, ...fallbacks];
  const first = async <T>(capability: Capability, call: (provider: Provider) => Promise<Result<T>> | undefined): Promise<Result<T>> => {
    let last: Result<T> = { ok: false, error: `no provider can ${capability}` };
    for (const provider of chain) {
      const result = call(provider);
      if (!result) continue;
      last = await result;
      if (last.ok) return last;
    }
    return last;
  };
  const composite: Provider = {
    id: primary.id,
    type: primary.type,
    capabilities: [...new Set(chain.flatMap((provider) => provider.capabilities))],
    chat: (request: ChatRequest) => first("chat", (provider) => provider.chat?.(request)),
    decide: (request: DecideRequest) => first("decide", (provider) => provider.decide?.(request)),
  };
  if (primary.decideMany) {
    composite.decideMany = async (requests) => {
      const result = await primary.decideMany!(requests);
      if (result.ok) return result;

      const results = await Promise.all(requests.map((request) => composite.decide!(request)));
      const failed = results.find((item) => !item.ok);
      return failed && !failed.ok ? failed : { ok: true, value: results.map((item) => (item as { ok: true; value: Decision }).value) };
    };
  }
  return composite;
}

type Pending = { request: DecideRequest; resolve: (result: Result<Decision>) => void };

/**
 * Per-run gateway to providers. Decisions issued in the same tick to a provider that has
 * `decideMany` are sent as one batch; others run as parallel `decide` calls.
 */
export class ProviderHub {
  private queues = new Map<string, Pending[]>();
  constructor(private providers: Map<string, Provider>, private runId: string, private emit: (event: RunEvent) => void) {}

  access(nodeId: string): ProviderAccess {
    const timed = async <T>(id: string, capability: Capability, call: () => Promise<Result<T>>) => {
      const start = performance.now();
      const result = await call();
      this.emit({ type: "provider:call", runId: this.runId, nodeId, provider: id, capability, ok: result.ok, ms: performance.now() - start });
      return result;
    };
    const get = (id: string, capability: Capability): Result<Provider> => {
      const provider = this.providers.get(id);
      if (!provider) return { ok: false, error: `unknown provider "${id}"` };
      return provider.capabilities.includes(capability) ? { ok: true, value: provider } : { ok: false, error: `provider "${id}" cannot ${capability}` };
    };
    return {
      chat: (id, request) => {
        const provider = get(id, "chat");
        return provider.ok ? timed(id, "chat", () => provider.value.chat!(request)) : Promise.resolve(provider);
      },
      decide: (id, request) => {
        const provider = get(id, "decide");
        return provider.ok ? timed(id, "decide", () => this.decide(provider.value, request)) : Promise.resolve(provider);
      },
    };
  }

  private decide(provider: Provider, request: DecideRequest): Promise<Result<Decision>> {
    if (!provider.decideMany) return provider.decide!(request);
    return new Promise((resolve) => {
      let queue = this.queues.get(provider.id);
      if (!queue) {
        queue = [];
        this.queues.set(provider.id, queue);
        queueMicrotask(() => void this.flush(provider));
      }
      queue.push({ request, resolve });
    });
  }

  private async flush(provider: Provider) {
    const batch = this.queues.get(provider.id)!;
    this.queues.delete(provider.id);
    if (batch.length > 1) {
      const result = await provider.decideMany!(batch.map((item) => item.request));
      if (result.ok && result.value.length === batch.length) {
        return batch.forEach((item, index) => item.resolve({ ok: true, value: result.value[index]! }));
      }
    }
    await Promise.all(batch.map(async (item) => item.resolve(await provider.decide!(item.request))));
  }
}
