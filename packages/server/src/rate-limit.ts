import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export type RateLimitOptions = {
  /** Sustained requests per second for each caller. */
  perSecond: number;
  /** Requests a caller can send at once. Defaults to `perSecond`, rounded up. */
  burst?: number;
  /** Most callers tracked at once. The least recently seen is forgotten first. */
  maxCallers?: number;
};

/**
 * Token bucket per caller, answering `429` with `Retry-After` instead of making the caller wait.
 * A caller is its bearer token (hashed), or the first `X-Forwarded-For` address, or one shared bucket.
 * Put it after authentication, so only valid tokens get a bucket.
 */
export function rateLimit(o: RateLimitOptions, now: () => number = Date.now): MiddlewareHandler {
  const burst = o.burst ?? Math.max(1, Math.ceil(o.perSecond));
  const max = o.maxCallers ?? 10_000;
  const buckets = new Map<string, { tokens: number; last: number }>();
  return async (c, next) => {
    const auth = c.req.header("authorization")?.replace(/^Bearer /i, "");
    const key = auth ? `t:${createHash("sha256").update(auth).digest("hex")}` : `ip:${c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "-"}`;
    const t = now();
    const b = buckets.get(key) ?? { tokens: burst, last: t };
    buckets.delete(key);
    b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * o.perSecond);
    b.last = t;
    buckets.set(key, b); // most recently seen last
    if (buckets.size > max) buckets.delete(buckets.keys().next().value!);
    if (b.tokens < 1) return c.json({ error: "rate limit exceeded" }, 429, { "retry-after": String(Math.ceil((1 - b.tokens) / o.perSecond)) });
    b.tokens -= 1;
    return next();
  };
}
