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
export function rateLimit(options: RateLimitOptions, now: () => number = Date.now): MiddlewareHandler {
  const burst = options.burst ?? Math.max(1, Math.ceil(options.perSecond));
  const max = options.maxCallers ?? 10_000;
  const buckets = new Map<string, { tokens: number; last: number }>();
  return async (context, next) => {
    const auth = context.req.header("authorization")?.replace(/^Bearer /i, "");
    const key = auth ? `t:${createHash("sha256").update(auth).digest("hex")}` : `ip:${context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "-"}`;
    const current = now();
    const bucket = buckets.get(key) ?? { tokens: burst, last: current };
    buckets.delete(key);
    bucket.tokens = Math.min(burst, bucket.tokens + ((current - bucket.last) / 1000) * options.perSecond);
    bucket.last = current;
    buckets.set(key, bucket); // most recently seen last
    if (buckets.size > max) buckets.delete(buckets.keys().next().value!);
    if (bucket.tokens < 1) return context.json({ error: "rate limit exceeded" }, 429, { "retry-after": String(Math.ceil((1 - bucket.tokens) / options.perSecond)) });
    bucket.tokens -= 1;
    return next();
  };
}
