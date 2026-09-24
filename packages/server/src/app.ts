import { createHash, timingSafeEqual } from "node:crypto";
import type { Channel } from "@milfordai/channels";
import { canonical, INVALID_INPUT, TOO_MANY_RUNS, type Engine, type RunResult } from "@milfordai/core";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream, streamSSE } from "hono/streaming";
import type { StreamingApi } from "hono/utils/stream";
import { createIdempotencyStore } from "./idempotency.js";
import { buildOpenApi } from "./openapi.js";
import { callerKey, rateLimit, type RateLimitOptions } from "./rate-limit.js";
import { memoryRunStore, summarize, toRecord, type RunStore } from "./runs.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

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
  const fields: Record<string, string> = {};
  if (delta.role !== undefined) fields.role = delta.role;
  if (delta.content !== undefined) fields.content = delta.content;
  return {
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [{ index: 0, delta: fields, finish_reason: delta.finish ?? null }],
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
export function createApp({ engine, tokens = [], maxBodyBytes = 1_000_000, idempotencyTtlMs = 600_000, runs = memoryRunStore(), recordRuns = "trace", middleware = [], rateLimit: limitOptions, channels = [], log = console.log }: AppOptions): Hono {
  if (tokens.some((token) => token.trim() === "")) {
    throw new Error("auth tokens must not be empty or whitespace: an empty token would authenticate requests that send no credentials");
  }

  const app = new Hono();
  const idempotent = createIdempotencyStore<RunResult>(idempotencyTtlMs);
  app.onError((error, context) => {
    log(JSON.stringify({ level: "error", msg: "unhandled", error: error.message }));
    return context.json({ error: "internal error" }, 500);
  });

  // Webhooks authenticate with their own signature, not the bearer tokens.
  app.use("/hooks/*", bodyLimit({ maxSize: maxBodyBytes, onError: (context) => context.json({ error: "body too large" }, 413) }));
  app.post("/hooks/:id", async (context) => {
    const channel = channels.find((channel) => channel.id === context.req.param("id") && channel.handle);
    return channel ? await channel.handle!(context.req.raw) : context.json({ error: "unknown webhook" }, 404);
  });

  app.use("/v1/*", bodyLimit({ maxSize: maxBodyBytes, onError: (context) => context.json({ error: "body too large" }, 413) }));
  app.get("/health", (context) => context.json({ status: "ok" }));

  const auth: MiddlewareHandler = async (context, next) => {
    if (!tokens.length) return next();
    const given = digest(context.req.header("authorization")?.replace(/^Bearer /i, "") ?? "");
    // Compare against every token, without short-circuiting on the first match.
    const ok = tokens.map((token) => timingSafeEqual(given, digest(token))).some(Boolean);
    return ok ? next() : context.json({ error: "unauthorized" }, 401);
  };
  // The rate limit comes after the token check, so only callers with a valid token get a bucket.
  const guard: MiddlewareHandler[] = [...middleware, auth, ...(limitOptions ? [rateLimit(limitOptions)] : [])];
  for (const handler of guard) app.use("/v1/*", handler);

  // The spec lists every loaded flow with its input schema, so it needs the same token as the API.
  for (const handler of guard) app.use("/openapi.json", handler);
  // Built once: flows are frozen at engine creation, and rebuilding the spec per request blocked the event
  // loop. An operation-name collision between flow ids fails here, at startup, instead of on every request.
  const openApiJson = JSON.stringify(buildOpenApi(engine.flows()));
  app.get("/openapi.json", (context) => context.body(openApiJson, 200, { "content-type": "application/json" }));

  app.get("/v1/flows", (context) => context.json({ flows: engine.flows() }));

  // Run history is scoped to the caller: a valid token lists and reads its own runs, never another caller's.
  app.get("/v1/runs", (context) => {
    const limit = Math.min(Math.max(Number(context.req.query("limit")) || 50, 1), 500);
    const caller = callerKey(context.req.header("authorization"));
    return context.json({ runs: runs.list({ flow: context.req.query("flow"), limit, caller }).map(summarize) });
  });
  app.get("/v1/runs/:id", (context) => {
    const record = runs.get(context.req.param("id"));
    return record && record.caller === callerKey(context.req.header("authorization")) ? context.json(record) : context.json({ error: `unknown run "${context.req.param("id")}"` }, 404);
  });

  /**
   * An OpenAI-compatible subset of `POST /chat/completions`. The `model` field is the id of a loaded flow;
   * the request runs that flow with `input = { model, messages, prompt }`, where `prompt` is the content of
   * the last user message, and the output node's text becomes the assistant message. `stream: true` returns
   * OpenAI-style SSE chunks ending with `[DONE]`. Extra OpenAI fields (`temperature`, `max_tokens`, ...) are
   * accepted and ignored: the flow controls behaviour. Embeddings and tool calls are deferred.
   */
  app.post("/v1/chat/completions", async (context) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await context.req.text()) || "{}") as Record<string, unknown>;
    } catch {
      return context.json(openaiError("body must be JSON", "invalid_request_error"), 400);
    }
    if (typeof body !== "object" || Array.isArray(body)) return context.json(openaiError("body must be an object", "invalid_request_error"), 400);

    const model = body.model;
    if (typeof model !== "string" || !model) return context.json(openaiError("model is required and must be the id of a loaded flow", "invalid_request_error"), 400);
    const isMessage = (message: unknown): message is { role: string; content: string } =>
      !!message && typeof message === "object" && typeof (message as Record<string, unknown>).role === "string" && typeof (message as Record<string, unknown>).content === "string";
    if (!Array.isArray(body.messages) || !body.messages.every(isMessage))
      return context.json(openaiError("messages must be an array of { role, content } objects", "invalid_request_error"), 400);
    if (body.stream !== undefined && typeof body.stream !== "boolean")
      return context.json(openaiError("stream must be a boolean", "invalid_request_error"), 400);
    if (!engine.flows().some((flow) => flow.id === model)) return context.json(openaiError(`model "${model}" is not a loaded flow`, "invalid_request_error"), 404);

    const timeoutMs = runTimeout(context.req.header("x-milford-timeout-ms"));
    if (Number.isNaN(timeoutMs))
      return context.json(openaiError(`X-Milford-Timeout-Ms must be a whole number of milliseconds from 1 to ${MAX_RUN_TIMEOUT_MS}`, "invalid_request_error"), 400);

    const streamRequest = body.stream === true;
    const lastUser = [...(body.messages as { role: string; content: string }[])].reverse().find((message) => message.role === "user");
    const input = { model, messages: body.messages, prompt: lastUser?.content ?? "" };

    const started = performance.now();
    const startedAt = new Date();
    const caller = callerKey(context.req.header("authorization"));
    const control = context.req.header("cache-control") ?? "";
    const cache = /\bno-store\b/i.test(control) ? "off" : /\bno-cache\b/i.test(control) ? "refresh" : undefined;
    const done = (ok: boolean, runId?: string, cacheField?: string) => log(JSON.stringify({ level: "info", msg: "run", flow: model, ok, runId, cache: cacheField, ms: Math.round(performance.now() - started) }));
    const save = (runResult: RunResult) => runResult.cache === "hit" || runs.save(toRecord(model, startedAt, performance.now() - started, runResult, input, recordRuns, caller));

    // The run happens before any streaming starts, so errors (busy, timeout, failing nodes) come back as
    // normal HTTP status codes instead of mid-stream surprises.
    const result = await engine.run(model, input, { signal: context.req.raw.signal, cache, timeoutMs });
    done(result.ok && result.value.ok, result.ok ? result.value.runId : undefined, result.ok ? result.value.cache : undefined);
    if (result.ok) save(result.value);
    if (!result.ok) return result.error === TOO_MANY_RUNS ? context.json(openaiError("the server is busy, retry after the Retry-After delay", "server_error"), 503, { "retry-after": "1" }) : context.json(openaiError(result.error, "server_error"), 500);

    const runResult = result.value;
    if (!runResult.ok) {
      const failed = Object.values(runResult.nodes).find((node) => node.status === "error");
      return context.json(openaiError(failed?.result?.error ?? "the flow did not complete successfully", "server_error"), 500);
    }

    const content = runResult.output?.output ?? "";
    if (!streamRequest) return context.json(chatCompletion(model, runResult.runId, content));

    // OpenAI-style SSE: a role delta, the content, the finish delta, then `[DONE]`.
    const id = `chatcmpl-${runResult.runId}`;
    context.header("content-type", "text/event-stream");
    return stream(context, async (streamApi: StreamingApi) => {
      await streamApi.write(`data: ${JSON.stringify(chatChunk(id, model, { role: "assistant" }))}\n\n`);
      if (content) await streamApi.write(`data: ${JSON.stringify(chatChunk(id, model, { content }))}\n\n`);
      await streamApi.write(`data: ${JSON.stringify(chatChunk(id, model, { finish: "stop" }))}\n\n`);
      await streamApi.write("data: [DONE]\n\n");
    });
  });

  app.post("/v1/flows/:id/run", async (context) => {
    const id = context.req.param("id");
    if (!engine.flows().some((flow) => flow.id === id)) return context.json({ error: `unknown flow "${id}"` }, 404);

    let body: { input?: Record<string, unknown> } = {};
    try {
      const text = await context.req.text();
      if (text) body = JSON.parse(text);
    } catch {
      return context.json({ error: "body must be JSON" }, 400);
    }
    const input = body.input ?? {};
    if (typeof input !== "object" || Array.isArray(input)) return context.json({ error: "input must be an object" }, 400);

    // A per-request timeout override, applied to this run only.
    const timeoutMs = runTimeout(context.req.header("x-milford-timeout-ms"));
    if (Number.isNaN(timeoutMs))
      return context.json({ error: `X-Milford-Timeout-Ms must be a whole number of milliseconds from 1 to ${MAX_RUN_TIMEOUT_MS}` }, 400);

    const sse = !!context.req.header("accept")?.includes("text/event-stream");

    // Idempotency-Key applies to JSON runs only. Replays do not count against the concurrency cap.
    // The key is namespaced by flow and caller: two callers using the same key must not see each other's runs.
    const requestKey = sse ? undefined : context.req.header("idempotency-key");
    const caller = callerKey(context.req.header("authorization"));
    const idemKey = requestKey && `${caller}\n${id}\n${requestKey}`;
    // canonical() sorts keys, so the same request with its keys in a different order is still the same request.
    let fingerprint: string;
    try {
      fingerprint = canonical(input);
    } catch {
      fingerprint = JSON.stringify(input); // an input too deep for canonical() still gets a raw fingerprint
    }
    if (idemKey) {
      const hit = idempotent.get(idemKey);
      if (hit) {
        if (hit.fingerprint !== fingerprint) return context.json({ error: "Idempotency-Key was already used with a different request" }, 422);
        const replay = await hit.done; // waits when the first request is still running
        if (replay) return context.json(replay, 200, { "idempotent-replayed": "true" });
      }
    }

    const started = performance.now();
    const startedAt = new Date();
    // A cache hit is an earlier run, not a new one, so it is not saved again.
    const save = (runResult: RunResult) => runResult.cache === "hit" || runs.save(toRecord(id, startedAt, performance.now() - started, runResult, input, recordRuns, caller));
    const done = (ok: boolean, runId?: string, cache?: string) => log(JSON.stringify({ level: "info", msg: "run", flow: id, ok, runId, cache, ms: Math.round(performance.now() - started) }));
    // `no-cache` skips the lookup of a cached flow and refreshes it, `no-store` skips the cache altogether.
    const control = context.req.header("cache-control") ?? "";
    const cache = /\bno-store\b/i.test(control) ? "off" : /\bno-cache\b/i.test(control) ? "refresh" : undefined;

    if (!sse) {
      const finish = idemKey ? idempotent.begin(idemKey, fingerprint) : undefined;
      let kept: RunResult | undefined;
      try {
        const result = await engine.run(id, input, { signal: context.req.raw.signal, cache, timeoutMs });
        done(result.ok && result.value.ok, result.ok ? result.value.runId : undefined, result.ok ? result.value.cache : undefined);
        if (result.ok) save(result.value);
        // Only successful runs are kept, so a retry after a failure runs again.
        if (result.ok && result.value.ok) kept = result.value;
        if (result.ok) return context.json(result.value);
        if (result.error.startsWith(INVALID_INPUT)) return context.json({ error: result.error }, 400);
        return result.error === TOO_MANY_RUNS ? context.json({ error: result.error }, 503, { "retry-after": "1" }) : context.json({ error: result.error }, 500);
      } finally {
        finish?.(kept);
      }
    }
    return streamSSE(context, async (streamApi) => {
      const abort = new AbortController();
      streamApi.onAbort(() => abort.abort());
      // A client that disconnected mid-run must not turn a failed write into an unhandled rejection.
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => (writes = writes.then(() => streamApi.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));
      // A comment every 15 s keeps idle proxies and clients from closing the connection during a long run.
      const heartbeat = setInterval(() => (writes = writes.then(() => streamApi.write(": keep-alive\n\n")).catch(() => {})), 15_000);
      const result = await engine.run(id, input, { signal: abort.signal, timeoutMs, onEvent: (event) => void send(event.type, event) });
      clearInterval(heartbeat);
      done(result.ok && result.value.ok, result.ok ? result.value.runId : undefined);
      if (result.ok) save(result.value);
      await send("result", result.ok ? result.value : { error: result.error });
    });
  });
  return app;
}
