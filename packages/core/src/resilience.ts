import type { Provider, Result } from "./types.js";

export type BreakerOptions = { /** Consecutive failures that open the circuit. */ failures: number; /** How long it stays open before one trial call. */ resetMs: number };
export type RateLimitOptions = { /** Sustained calls per second. */ perSecond: number; /** Bucket size; defaults to perSecond. */ burst?: number };

type Call<T> = (signal?: AbortSignal) => Promise<Result<T>>;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Applies `wrap` to each capability the provider has, so wrapped providers keep their exact shape. */
function wrapAll(p: Provider, wrap: <T>(signal: AbortSignal | undefined, call: Call<T>) => Promise<Result<T>>): Provider {
  const out: Provider = { ...p };
  if (p.chat) out.chat = (req) => wrap(req.signal, () => p.chat!(req));
  if (p.decide) out.decide = (req) => wrap(req.signal, () => p.decide!(req));
  if (p.decideMany) out.decideMany = (reqs) => wrap(reqs[0]?.signal, () => p.decideMany!(reqs));
  return out;
}

/**
 * Circuit breaker. After `failures` consecutive errors calls fail fast (so a fallback provider takes over
 * immediately) until `resetMs` has passed; then one trial call decides whether it closes again.
 * Calls cancelled by the caller do not count as failures.
 */
export function withBreaker(p: Provider, o: BreakerOptions, now: () => number = Date.now): Provider {
  let fails = 0;
  let openedAt = 0;
  let probing = false;
  return wrapAll(p, async (signal, call) => {
    const open = fails >= o.failures;
    if (open && (probing || now() - openedAt < o.resetMs)) return fail(`circuit open for provider "${p.id}"`);
    if (open) probing = true;
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call(signal);
    } catch (e) {
      r = fail(e instanceof Error ? e.message : String(e));
    }
    probing = false;
    if (r.ok) fails = 0;
    else if (!signal?.aborted) {
      fails++;
      if (fails >= o.failures) openedAt = now();
    }
    return r;
  });
}

/** Token-bucket rate limit. Calls over the limit wait their turn, and give up when the run is aborted. */
export function withRateLimit(p: Provider, o: RateLimitOptions, now: () => number = Date.now): Provider {
  const burst = o.burst ?? Math.max(1, Math.ceil(o.perSecond));
  let tokens = burst;
  let last = now();
  const take = async (signal?: AbortSignal): Promise<boolean> => {
    for (;;) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * o.perSecond);
      last = t;
      if (tokens >= 1) return (tokens -= 1), true;
      const wait = Math.ceil(((1 - tokens) / o.perSecond) * 1000);
      const aborted = await new Promise<boolean>((res) => {
        if (signal?.aborted) return res(true);
        const timer = setTimeout(() => res(false), wait);
        signal?.addEventListener("abort", () => (clearTimeout(timer), res(true)), { once: true });
      });
      if (aborted) return false;
    }
  };
  return wrapAll(p, async (signal, call) => ((await take(signal)) ? call(signal) : fail("aborted while waiting for the rate limit")));
}
