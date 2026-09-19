import { createHash, timingSafeEqual } from "node:crypto";
import type { Channel } from "@milfordai/channels";
import { TOO_MANY_RUNS, type Engine, type RunResult } from "@milfordai/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { createIdempotencyStore } from "./idempotency.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export type AppOptions = {
  engine: Engine;
  tokens?: string[];
  maxBodyBytes?: number;
  /** How long a completed run is kept for `Idempotency-Key` replays. */
  idempotencyTtlMs?: number;
  /** Channels with a `handle` are mounted at POST /hooks/:id. */
  channels?: Channel[];
  /** One JSON line per finished run. Defaults to stdout; pass a no-op to silence. */
  log?: (line: string) => void;
};

/** HTTP surface over an Engine. */
export function createApp({ engine, tokens = [], maxBodyBytes = 1_000_000, idempotencyTtlMs = 600_000, channels = [], log = console.log }: AppOptions): Hono {
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

  app.use("/v1/*", async (c, next) => {
    if (!tokens.length) return next();
    const given = digest(c.req.header("authorization")?.replace(/^Bearer /i, "") ?? "");
    // Compare against every token, without short-circuiting on the first match.
    const ok = tokens.map((t) => timingSafeEqual(given, digest(t))).some(Boolean);
    return ok ? next() : c.json({ error: "unauthorized" }, 401);
  });

  app.get("/v1/flows", (c) => c.json({ flows: engine.flows() }));

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
    const done = (ok: boolean, runId?: string) => log(JSON.stringify({ level: "info", msg: "run", flow: id, ok, runId, ms: Math.round(performance.now() - started) }));

    if (!sse) {
      const finish = ikey ? idempotent.begin(ikey, fingerprint) : undefined;
      let kept: RunResult | undefined;
      try {
        const r = await engine.run(id, input, { signal: c.req.raw.signal });
        done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined);
        // Only successful runs are kept, so a retry after a failure runs again.
        if (r.ok && r.value.ok) kept = r.value;
        if (r.ok) return c.json(r.value);
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
      await send("result", r.ok ? r.value : { error: r.error });
    });
  });
  return app;
}
