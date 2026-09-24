import { createEngine, defaultRegistry } from "@milfordai/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { rateLimit } from "../src/rate-limit.js";

const limited = (options: Parameters<typeof rateLimit>[0], clock: { t: number }) => {
  const app = new Hono();
  app.use("*", rateLimit(options, () => clock.t));
  app.get("/", (context) => context.text("ok"));
  return app;
};
const get = (app: Hono, token?: string, headers: Record<string, string> = {}) => app.request("/", { headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers } });

describe("rateLimit", () => {
  it("allows a burst, then answers 429 with Retry-After, and refills over time", async () => {
    const clock = { t: 0 };
    const app = limited({ perSecond: 2, burst: 3 }, clock);
    expect((await Promise.all([get(app, "a"), get(app, "a"), get(app, "a")])).map((response) => response.status)).toEqual([200, 200, 200]);
    const overLimit = await get(app, "a");
    expect(overLimit.status).toBe(429);
    expect(overLimit.headers.get("retry-after")).toBe("1");
    expect(await overLimit.json()).toEqual({ error: "rate limit exceeded" });
    clock.t += 500; // one token back at 2 per second
    expect((await get(app, "a")).status).toBe(200);
    expect((await get(app, "a")).status).toBe(429);
  });

  it("gives each token its own bucket, and never fills beyond the burst", async () => {
    const clock = { t: 0 };
    const app = limited({ perSecond: 1, burst: 1 }, clock);
    expect((await get(app, "a")).status).toBe(200);
    expect((await get(app, "a")).status).toBe(429);
    expect((await get(app, "b")).status).toBe(200);
    clock.t += 60_000;
    expect((await get(app, "a")).status).toBe(200);
    expect((await get(app, "a")).status).toBe(429); // a long pause does not bank more than the burst
  });

  it("tells callers apart by X-Forwarded-For when there is no token, and forgets the oldest callers", async () => {
    const clock = { t: 0 };
    const app = limited({ perSecond: 1, burst: 1, maxCallers: 2 }, clock);
    const ip = (address: string) => get(app, undefined, { "x-forwarded-for": `${address}, 10.0.0.1` });
    expect((await ip("1.1.1.1")).status).toBe(200);
    expect((await ip("1.1.1.1")).status).toBe(429);
    expect((await ip("2.2.2.2")).status).toBe(200);
    await ip("3.3.3.3"); // pushes 1.1.1.1 out
    expect((await ip("1.1.1.1")).status).toBe(200); // a fresh bucket: memory stays bounded
  });
});

describe("createApp hooks", () => {
  const engine = createEngine({ registry: defaultRegistry(), flows: [{ id: "f", nodes: [{ id: "out", type: "output" }], edges: [] }] });
  if (!engine.ok) throw new Error(engine.error);
  const call = (app: ReturnType<typeof createApp>, token = "t") => app.request("/v1/flows", { headers: { authorization: `Bearer ${token}` } });

  it("runs middleware before the token check, and a response from it ends the request", async () => {
    const seen: string[] = [];
    const app = createApp({
      engine: engine.value,
      tokens: ["t"],
      log: () => {},
      middleware: [async (context, next) => { seen.push("hook"); if (context.req.header("x-block")) return context.json({ error: "blocked" }, 418); await next(); }],
    });
    expect((await call(app)).status).toBe(200);
    expect(seen).toEqual(["hook"]);
    expect((await app.request("/v1/flows", { headers: { "x-block": "1", authorization: "Bearer t" } })).status).toBe(418);
    expect((await call(app, "wrong")).status).toBe(401); // the hook ran, then the built-in check
    expect(seen).toHaveLength(3);
    expect((await app.request("/health")).status).toBe(200); // /health is not guarded
    expect(seen).toHaveLength(3);
  });

  it("limits each token after the token check, on the API and the spec, and not /health", async () => {
    const app = createApp({ engine: engine.value, tokens: ["a", "b"], log: () => {}, rateLimit: { perSecond: 0.001, burst: 2 } });
    expect([(await call(app, "a")).status, (await call(app, "a")).status, (await call(app, "a")).status]).toEqual([200, 200, 429]);
    expect((await call(app, "b")).status).toBe(200);
    expect((await app.request("/openapi.json", { headers: { authorization: "Bearer a" } })).status).toBe(429); // same bucket as /v1
    for (let index = 0; index < 5; index++) expect((await call(app, "wrong")).status).toBe(401); // invalid tokens are not counted
    expect((await app.request("/health")).status).toBe(200);
  });
});
