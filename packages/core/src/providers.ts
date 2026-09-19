import type { Capability, ChatRequest, DecideRequest, Decision, Provider, ProviderAccess, Result, RunEvent } from "./types.js";

/** Composite provider: tries `primary`, then each fallback in order. */
export function withFallback(primary: Provider, fallbacks: Provider[]): Provider {
  const chain = [primary, ...fallbacks];
  const first = async <T>(cap: Capability, call: (p: Provider) => Promise<Result<T>> | undefined): Promise<Result<T>> => {
    let last: Result<T> = { ok: false, error: `no provider can ${cap}` };
    for (const p of chain) {
      const r = call(p);
      if (!r) continue;
      last = await r;
      if (last.ok) return last;
    }
    return last;
  };
  const composite: Provider = {
    id: primary.id,
    type: primary.type,
    capabilities: [...new Set(chain.flatMap((p) => p.capabilities))],
    chat: (req: ChatRequest) => first("chat", (p) => p.chat?.(req)),
    decide: (req: DecideRequest) => first("decide", (p) => p.decide?.(req)),
  };
  if (primary.decideMany)
    composite.decideMany = async (reqs) => {
      const r = await primary.decideMany!(reqs);
      if (r.ok) return r;
      const each = await Promise.all(reqs.map((q) => composite.decide!(q)));
      const bad = each.find((x) => !x.ok);
      return bad && !bad.ok ? bad : { ok: true, value: each.map((x) => (x as { ok: true; value: Decision }).value) };
    };
  return composite;
}

type Pending = { req: DecideRequest; resolve: (r: Result<Decision>) => void };

/**
 * Per-run gateway to providers. Decisions issued in the same tick to a provider that has
 * `decideMany` are sent as one batch; others run as parallel `decide` calls.
 */
export class ProviderHub {
  private queues = new Map<string, Pending[]>();
  constructor(private providers: Map<string, Provider>, private runId: string, private emit: (e: RunEvent) => void) {}

  access(nodeId: string): ProviderAccess {
    const timed = async <T>(id: string, capability: Capability, call: () => Promise<Result<T>>) => {
      const start = performance.now();
      const r = await call();
      this.emit({ type: "provider:call", runId: this.runId, nodeId, provider: id, capability, ok: r.ok, ms: performance.now() - start });
      return r;
    };
    const get = (id: string, cap: Capability): Result<Provider> => {
      const p = this.providers.get(id);
      if (!p) return { ok: false, error: `unknown provider "${id}"` };
      return p.capabilities.includes(cap) ? { ok: true, value: p } : { ok: false, error: `provider "${id}" cannot ${cap}` };
    };
    return {
      chat: (id, req) => {
        const p = get(id, "chat");
        return p.ok ? timed(id, "chat", () => p.value.chat!(req)) : Promise.resolve(p);
      },
      decide: (id, req) => {
        const p = get(id, "decide");
        return p.ok ? timed(id, "decide", () => this.decide(p.value, req)) : Promise.resolve(p);
      },
    };
  }

  private decide(p: Provider, req: DecideRequest): Promise<Result<Decision>> {
    if (!p.decideMany) return p.decide!(req);
    return new Promise((resolve) => {
      let q = this.queues.get(p.id);
      if (!q) {
        q = [];
        this.queues.set(p.id, q);
        queueMicrotask(() => void this.flush(p));
      }
      q.push({ req, resolve });
    });
  }

  private async flush(p: Provider) {
    const batch = this.queues.get(p.id)!;
    this.queues.delete(p.id);
    if (batch.length > 1) {
      const r = await p.decideMany!(batch.map((b) => b.req));
      if (r.ok && r.value.length === batch.length) return batch.forEach((b, i) => b.resolve({ ok: true, value: r.value[i]! }));
    }
    await Promise.all(batch.map(async (b) => b.resolve(await p.decide!(b.req))));
  }
}
