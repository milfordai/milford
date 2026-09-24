import type { Provider, Result } from "./types.js";

export type BreakerOptions = { /** Consecutive failures that open the circuit. */ failures: number; /** How long it stays open before one trial call. */ resetMs: number };
export type RateLimitOptions = { /** Sustained calls per second. */ perSecond: number; /** Bucket size; defaults to perSecond. */ burst?: number };

type Call<T> = (signal?: AbortSignal) => Promise<Result<T>>;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Applies `wrap` to each capability the provider has, so wrapped providers keep their exact shape. */
function wrapAll(provider: Provider, wrap: <T>(signal: AbortSignal | undefined, call: Call<T>) => Promise<Result<T>>): Provider {
  const out: Provider = { ...provider };
  if (provider.chat) out.chat = (request) => wrap(request.signal, () => provider.chat!(request));
  if (provider.decide) out.decide = (request) => wrap(request.signal, () => provider.decide!(request));
  if (provider.decideMany) out.decideMany = (requests) => wrap(requests[0]?.signal, () => provider.decideMany!(requests));
  return out;
}

/**
 * Circuit breaker. After `failures` consecutive errors calls fail fast (so a fallback provider takes over
 * immediately) until `resetMs` has passed; then one trial call decides whether it closes again.
 * Calls cancelled by the caller do not count as failures.
 */
export function withBreaker(provider: Provider, options: BreakerOptions, now: () => number = Date.now): Provider {
  let fails = 0;
  let openedAt = 0;
  let probing = false;
  return wrapAll(provider, async (signal, call) => {
    const open = fails >= options.failures;
    if (open && (probing || now() - openedAt < options.resetMs)) return fail(`circuit open for provider "${provider.id}"`);
    if (open) probing = true;

    let result: Awaited<ReturnType<typeof call>>;
    try {
      result = await call(signal);
    } catch (error) {
      result = fail(error instanceof Error ? error.message : String(error));
    }
    probing = false;

    if (result.ok) fails = 0;
    else if (!signal?.aborted) {
      fails++;
      if (fails >= options.failures) openedAt = now();
    }
    return result;
  });
}

/** Token-bucket rate limit. Calls over the limit wait their turn, and give up when the run is aborted. */
export function withRateLimit(provider: Provider, options: RateLimitOptions, now: () => number = Date.now): Provider {
  const burst = options.burst ?? Math.max(1, Math.ceil(options.perSecond));
  let tokens = burst;
  let last = now();
  const take = async (signal?: AbortSignal): Promise<boolean> => {
    for (;;) {
      const current = now();
      tokens = Math.min(burst, tokens + ((current - last) / 1000) * options.perSecond);
      last = current;
      if (tokens >= 1) return (tokens -= 1), true;

      const wait = Math.ceil(((1 - tokens) / options.perSecond) * 1000);
      const aborted = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(true);
        const timer = setTimeout(() => resolve(false), wait);
        signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(true)), { once: true });
      });
      if (aborted) return false;
    }
  };
  return wrapAll(provider, async (signal, call) => ((await take(signal)) ? call(signal) : fail("aborted while waiting for the rate limit")));
}
