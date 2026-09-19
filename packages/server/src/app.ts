import { createHash, timingSafeEqual } from "node:crypto";
import type { Channel } from "@milfordai/channels";
import { INVALID_INPUT, TOO_MANY_RUNS, type Engine, type RunResult } from "@milfordai/core";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { createIdempotencyStore } from "./idempotency.js";
import { buildOpenApi } from "./openapi.js";
import { rateLimit, type RateLimitOptions } from "./rate-limit.js";
import { memoryRunStore, summarize, toRecord, type RunStore } from "./runs.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export type AppOptions = {
  engine: Engine;
  tokens?: string[];
  maxBodyBytes?: number;
  /** How long a completed run is kept for `Idempotency-Key` replays. */
  idempotencyTtlMs?: number;
  /**
   * Request middleware for `/v1/*` and `/openapi.json`, run before the bearer token check. A middleware that
   * returns a response ends the request, so it can add its own authentication, quotas or audit logging.
   */
  middleware?: MiddlewareHandler[];
  /** Limits the requests of each caller (each bearer token) to `perSecond`, with a `burst`. Over the limit: `429`. Off by default. */
  rateLimit?: RateLimitOptions;
  /** Finished runs of the API are saved here, and listed at `GET /v1/runs`. In memory by default. */
  runs?: RunStore;
  /** What a saved run keeps. `trace` (default) is status, timing and errors. `full` adds inputs and node results. */
  recordRuns?: "trace" | "full";
  /** Channels with a `handle` are mounted at POST /hooks/:id. */
  channels?: Channel[];
  /** One JSON line per finished run. Defaults to stdout; pass a no-op to silence. */
  log?: (line: string) => void;
};

/** HTTP surface over an Engine. */
export function createApp({ engine, tokens = [], maxBodyBytes = 1_000_000, idempotencyTtlMs = 600_000, runs = memoryRunStore(), recordRuns = "trace", middleware = [], rateLimit: limit, channels = [], log = console.log }: AppOptions): Hono {
  const app = new Hono();
  const idempotent = createIdempotencyStore<RunResult>(idempotencyTtlMs);
  app.onError((err, c) => {
    log(JSON.stringify({ level: "error", msg: "unhandled", error: err.message }));
    return c.json({ error: "internal error" }, 500);
  });
  // Webhooks authenticate with their own signature, not the bearer tokens.
  app.use("/hooks/*", bodyLimit({ maxSize: maxBodyBytes, onError: (c) => c.json({ error: "body too large" }, 413) }));
  app.post("/hooks/:id", async (c) => {
    const ch = channels.find((x) => x.id === c.req.param("id") && x.handle);
    return ch ? await ch.handle!(c.req.raw) : c.json({ error: "unknown webhook" }, 404);
  });
  app.use("/v1/*", bodyLimit({ maxSize: maxBodyBytes, onError: (c) => c.json({ error: "body too large" }, 413) }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  const auth: MiddlewareHandler = async (c, next) => {
    if (!tokens.length) return next();
    const given = digest(c.req.header("authorization")?.replace(/^Bearer /i, "") ?? "");
    // Compare against every token, without short-circuiting on the first match.
    const ok = tokens.map((t) => timingSafeEqual(given, digest(t))).some(Boolean);
    return ok ? next() : c.json({ error: "unauthorized" }, 401);
  };
  // The rate limit comes after the token check, so only callers with a valid token get a bucket.
  const guard: MiddlewareHandler[] = [...middleware, auth, ...(limit ? [rateLimit(limit)] : [])];
  for (const h of guard) app.use("/v1/*", h);

  // The spec lists every loaded flow with its input schema, so it needs the same token as the API.
  for (const h of guard) app.use("/openapi.json", h);
  app.get("/openapi.json", (c) => c.json(buildOpenApi(engine.flows())));

  app.get("/v1/flows", (c) => c.json({ flows: engine.flows() }));

  app.get("/v1/runs", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
    return c.json({ runs: runs.list({ flow: c.req.query("flow"), limit }).map(summarize) });
  });
  app.get("/v1/runs/:id", (c) => {
    const r = runs.get(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: `unknown run "${c.req.param("id")}"` }, 404);
  });

  app.post("/v1/flows/:id/run", async (c) => {
    const id = c.req.param("id");
    if (!engine.flows().some((f) => f.id === id)) return c.json({ error: `unknown flow "${id}"` }, 404);
    let body: { input?: Record<string, unknown> } = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text);
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const input = body.input ?? {};
    if (typeof input !== "object" || Array.isArray(input)) return c.json({ error: "input must be an object" }, 400);
    const sse = !!c.req.header("accept")?.includes("text/event-stream");

    // Idempotency-Key applies to JSON runs only. Replays do not count against the concurrency cap.
    const key = sse ? undefined : c.req.header("idempotency-key");
    const ikey = key && `${id}\n${key}`;
    const fingerprint = JSON.stringify(input);
    if (ikey) {
      const hit = idempotent.get(ikey);
      if (hit) {
        if (hit.fingerprint !== fingerprint) return c.json({ error: "Idempotency-Key was already used with a different request" }, 422);
        const replay = await hit.done; // waits when the first request is still running
        if (replay) return c.json(replay, 200, { "idempotent-replayed": "true" });
      }
    }
    const started = performance.now();
    const startedAt = new Date();
    // A cache hit is an earlier run, not a new one, so it is not saved again.
    const save = (r: RunResult) => r.cache === "hit" || runs.save(toRecord(id, startedAt, performance.now() - started, r, input, recordRuns));
    const done = (ok: boolean, runId?: string, cache?: string) => log(JSON.stringify({ level: "info", msg: "run", flow: id, ok, runId, cache, ms: Math.round(performance.now() - started) }));
    // `no-cache` skips the lookup of a cached flow and refreshes it, `no-store` skips the cache altogether.
    const control = c.req.header("cache-control") ?? "";
    const cache = /\bno-store\b/i.test(control) ? "off" : /\bno-cache\b/i.test(control) ? "refresh" : undefined;

    if (!sse) {
      const finish = ikey ? idempotent.begin(ikey, fingerprint) : undefined;
      let kept: RunResult | undefined;
      try {
        const r = await engine.run(id, input, { signal: c.req.raw.signal, cache });
        done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined, r.ok ? r.value.cache : undefined);
        if (r.ok) save(r.value);
        // Only successful runs are kept, so a retry after a failure runs again.
        if (r.ok && r.value.ok) kept = r.value;
        if (r.ok) return c.json(r.value);
        if (r.error.startsWith(INVALID_INPUT)) return c.json({ error: r.error }, 400);
        return r.error === TOO_MANY_RUNS ? c.json({ error: r.error }, 503, { "retry-after": "1" }) : c.json({ error: r.error }, 500);
      } finally {
        finish?.(kept);
      }
    }
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // A client that disconnected mid-run must not turn a failed write into an unhandled rejection.
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => (writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));
      const r = await engine.run(id, input, { signal: abort.signal, onEvent: (e) => void send(e.type, e) });
      done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined);
      if (r.ok) save(r.value);
      await send("result", r.ok ? r.value : { error: r.error });
    });
  });
  return app;
}
