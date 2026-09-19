import { createHash, timingSafeEqual } from "node:crypto";
import type { Channel } from "@loage/channels";
import type { Engine } from "@loage/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";

const digest = (s: string) => createHash("sha256").update(s).digest();

export type AppOptions = {
  engine: Engine;
  tokens?: string[];
  runTimeoutMs?: number;
  maxConcurrentRuns?: number;
  maxBodyBytes?: number;
  /** Channels with a `handle` are mounted at POST /hooks/:id. */
  channels?: Channel[];
  /** One JSON line per finished run. Defaults to stdout; pass a no-op to silence. */
  log?: (line: string) => void;
};

/** HTTP surface over an Engine. */
export function createApp({ engine, tokens = [], runTimeoutMs, maxConcurrentRuns = 64, maxBodyBytes = 1_000_000, channels = [], log = console.log }: AppOptions): Hono {
  const app = new Hono();
  let active = 0;
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
    if (active >= maxConcurrentRuns) return c.json({ error: "too many concurrent runs" }, 503, { "retry-after": "1" });
    const opts = { timeoutMs: runTimeoutMs };
    const started = performance.now();
    const done = (ok: boolean, runId?: string) => log(JSON.stringify({ level: "info", msg: "run", flow: id, ok, runId, ms: Math.round(performance.now() - started) }));

    if (!c.req.header("accept")?.includes("text/event-stream")) {
      active++;
      try {
        const r = await engine.run(id, input, { ...opts, signal: c.req.raw.signal });
        done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined);
        return r.ok ? c.json(r.value) : c.json({ error: r.error }, 500);
      } finally {
        active--;
      }
    }
    return streamSSE(c, async (stream) => {
      active++;
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // A client that disconnected mid-run must not turn a failed write into an unhandled rejection.
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => (writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));
      try {
        const r = await engine.run(id, input, { ...opts, signal: abort.signal, onEvent: (e) => void send(e.type, e) });
        done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined);
        await send("result", r.ok ? r.value : { error: r.error });
      } finally {
        active--;
      }
    });
  });
  return app;
}
