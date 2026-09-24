/**
 * Small timing utilities for the reliability layer: assertions assert ordering and bounds, never exact
 * milliseconds, and waits are as short as the behaviour needs.
 */

/** Polls `check` until it returns true, or fails after `timeoutMs`. */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Runs `fn` and returns its value together with the elapsed milliseconds, for bound assertions. */
export async function elapsedOf<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

/** Sleeps for `ms`, for the few behaviours that need a wall-clock wait (circuit breaker reset). */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
