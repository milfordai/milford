import { createHash, timingSafeEqual } from "node:crypto";
import type { Channel } from "@milfordai/channels";
import { INVALID_INPUT, TOO_MANY_RUNS, type Engine, type RunResult } from "@milfordai/core";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream, streamSSE } from "hono/streaming";
import type { StreamingApi } from "hono/utils/stream";
import { createIdempotencyStore } from "./idempotency.js";
import { buildOpenApi } from "./openapi.js";
import { rateLimit, type RateLimitOptions } from "./rate-limit.js";
import { memoryRunStore, summarize, toRecord, type RunStore } from "./runs.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Highest `X-Milford-Timeout-Ms` a caller may ask for, so a run can never be pinned for too long. */
export const MAX_RUN_TIMEOUT_MS = 600_000;

/** Parses `X-Milford-Timeout-Ms`: a whole number of milliseconds, from 1 to `MAX_RUN_TIMEOUT_MS`. */
function runTimeout(header: string | undefined): number | undefined {
  if (header === undefined || header === "") return undefined;
  const ms = Number(header);
  return Number.isInteger(ms) && ms >= 1 && ms <= MAX_RUN_TIMEOUT_MS ? ms : NaN;
}

/** OpenAI-compatible error envelope, so OpenAI SDK clients can read `error.message`. */
const openaiError = (message: string, type: "invalid_request_error" | "server_error") => ({ error: { message, type, param: null, code: null } });

const now = () => Math.floor(Date.now() / 1000);

/** A `chat.completion` response built from the output node of a finished run. */
const chatCompletion = (model: string, runId: string, content: string) => ({
  id: `chatcmpl-${runId}`,
  object: "chat.completion",
  created: now(),
  model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

/** A `chat.completion.chunk` delta for OpenAI-style SSE. */
const chatChunk = (id: string, model: string, delta: { role?: string; content?: string; finish?: string }) => {
  const d: Record<string, string> = {};
  if (delta.role !== undefined) d.role = delta.role;
  if (delta.content !== undefined) d.content = delta.content;
  return {
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [{ index: 0, delta: d, finish_reason: delta.finish ?? null }],
  };
};

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

  /**
   * An OpenAI-compatible subset of `POST /chat/completions`. The `model` field is the id of a loaded flow;
   * the request runs that flow with `input = { model, messages, prompt }`, where `prompt` is the content of
   * the last user message, and the output node's text becomes the assistant message. `stream: true` returns
   * OpenAI-style SSE chunks ending with `[DONE]`. Extra OpenAI fields (`temperature`, `max_tokens`, ...) are
   * accepted and ignored: the flow controls behaviour. Embeddings and tool calls are deferred.
   */
  app.post("/v1/chat/completions", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await c.req.text()) || "{}") as Record<string, unknown>;
    } catch {
      return c.json(openaiError("body must be JSON", "invalid_request_error"), 400);
    }
    if (typeof body !== "object" || Array.isArray(body)) return c.json(openaiError("body must be an object", "invalid_request_error"), 400);
    const model = body.model;
    if (typeof model !== "string" || !model) return c.json(openaiError("model is required and must be the id of a loaded flow", "invalid_request_error"), 400);
    const isMessage = (m: unknown): m is { role: string; content: string } =>
      !!m && typeof m === "object" && typeof (m as Record<string, unknown>).role === "string" && typeof (m as Record<string, unknown>).content === "string";
    if (!Array.isArray(body.messages) || !body.messages.every(isMessage))
      return c.json(openaiError("messages must be an array of { role, content } objects", "invalid_request_error"), 400);
    if (body.stream !== undefined && typeof body.stream !== "boolean")
      return c.json(openaiError("stream must be a boolean", "invalid_request_error"), 400);
    if (!engine.flows().some((f) => f.id === model)) return c.json(openaiError(`model "${model}" is not a loaded flow`, "invalid_request_error"), 404);
    const timeoutMs = runTimeout(c.req.header("x-milford-timeout-ms"));
    if (Number.isNaN(timeoutMs))
      return c.json(openaiError(`X-Milford-Timeout-Ms must be a whole number of milliseconds from 1 to ${MAX_RUN_TIMEOUT_MS}`, "invalid_request_error"), 400);
    const streamRequest = body.stream === true;
    const lastUser = [...(body.messages as { role: string; content: string }[])].reverse().find((m) => m.role === "user");
    const input = { model, messages: body.messages, prompt: lastUser?.content ?? "" };

    const started = performance.now();
    const startedAt = new Date();
    const control = c.req.header("cache-control") ?? "";
    const cache = /\bno-store\b/i.test(control) ? "off" : /\bno-cache\b/i.test(control) ? "refresh" : undefined;
    const done = (ok: boolean, runId?: string, cacheField?: string) => log(JSON.stringify({ level: "info", msg: "run", flow: model, ok, runId, cache: cacheField, ms: Math.round(performance.now() - started) }));
    const save = (r: RunResult) => r.cache === "hit" || runs.save(toRecord(model, startedAt, performance.now() - started, r, input, recordRuns));

    // The run happens before any streaming starts, so errors (busy, timeout, failing nodes) come back as
    // normal HTTP status codes instead of mid-stream surprises.
    const r = await engine.run(model, input, { signal: c.req.raw.signal, cache, timeoutMs });
    done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined, r.ok ? r.value.cache : undefined);
    if (r.ok) save(r.value);
    if (!r.ok) return r.error === TOO_MANY_RUNS ? c.json(openaiError("the server is busy, retry after the Retry-After delay", "server_error"), 503, { "retry-after": "1" }) : c.json(openaiError(r.error, "server_error"), 500);
    const result = r.value;
    if (!result.ok) {
      const failed = Object.values(result.nodes).find((n) => n.status === "error");
      return c.json(openaiError(failed?.result?.error ?? "the flow did not complete successfully", "server_error"), 500);
    }
    const content = result.output?.output ?? "";
    if (!streamRequest) return c.json(chatCompletion(model, result.runId, content));

    // OpenAI-style SSE: a role delta, the content, the finish delta, then `[DONE]`.
    const id = `chatcmpl-${result.runId}`;
    c.header("content-type", "text/event-stream");
    return stream(c, async (s: StreamingApi) => {
      await s.write(`data: ${JSON.stringify(chatChunk(id, model, { role: "assistant" }))}\n\n`);
      if (content) await s.write(`data: ${JSON.stringify(chatChunk(id, model, { content }))}\n\n`);
      await s.write(`data: ${JSON.stringify(chatChunk(id, model, { finish: "stop" }))}\n\n`);
      await s.write("data: [DONE]\n\n");
    });
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
    // A per-request timeout override, applied to this run only.
    const timeoutMs = runTimeout(c.req.header("x-milford-timeout-ms"));
    if (Number.isNaN(timeoutMs))
      return c.json({ error: `X-Milford-Timeout-Ms must be a whole number of milliseconds from 1 to ${MAX_RUN_TIMEOUT_MS}` }, 400);
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
        const r = await engine.run(id, input, { signal: c.req.raw.signal, cache, timeoutMs });
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
      const r = await engine.run(id, input, { signal: abort.signal, timeoutMs, onEvent: (e) => void send(e.type, e) });
      done(r.ok && r.value.ok, r.ok ? r.value.runId : undefined);
      if (r.ok) save(r.value);
      await send("result", r.ok ? r.value : { error: r.error });
    });
  });
  return app;
}
