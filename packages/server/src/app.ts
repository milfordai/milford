import { createHash, timingSafeEqual } from "node:crypto";
import type { Engine } from "@loage/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const digest = (s: string) => createHash("sha256").update(s).digest();

export type AppOptions = { engine: Engine; tokens?: string[]; runTimeoutMs?: number };

/** HTTP surface over an Engine. */
export function createApp({ engine, tokens = [], runTimeoutMs }: AppOptions): Hono {
  const app = new Hono();
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
    const opts = { timeoutMs: runTimeoutMs };

    if (!c.req.header("accept")?.includes("text/event-stream")) {
      const r = await engine.run(id, input, { ...opts, signal: c.req.raw.signal });
      return r.ok ? c.json(r.value) : c.json({ error: r.error }, 500);
    }
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const pending: Promise<unknown>[] = [];
      const r = await engine.run(id, input, { ...opts, signal: abort.signal, onEvent: (e) => void pending.push(stream.writeSSE({ event: e.type, data: JSON.stringify(e) })) });
      await Promise.all(pending);
      await stream.writeSSE({ event: "result", data: JSON.stringify(r.ok ? r.value : { error: r.error }) });
    });
  });
  return app;
}
