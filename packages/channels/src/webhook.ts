import { createHmac, timingSafeEqual } from "node:crypto";
import { TOO_MANY_RUNS } from "@loage/core";
import { z } from "zod";
import type { Channel, ChannelDeps } from "./types.js";

export const webhookConfig = z.object({ id: z.string(), type: z.literal("webhook"), flow: z.string(), secret: z.string().min(16) });
const TOLERANCE_S = 300;

/**
 * Signed inbound webhook. The caller sends `x-loage-timestamp` (unix seconds) and
 * `x-loage-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 * The JSON body becomes the flow input; the response carries the flow output.
 */
export function webhook(cfg: z.infer<typeof webhookConfig>, deps: ChannelDeps): Channel {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    id: cfg.id,
    type: "webhook",
    start: async () => {},
    stop: async () => {},
    async handle(req) {
      const raw = await req.text();
      const ts = req.headers.get("x-loage-timestamp") ?? "";
      const given = (req.headers.get("x-loage-signature") ?? "").replace(/^sha256=/, "");
      const want = createHmac("sha256", cfg.secret).update(`${ts}.${raw}`).digest("hex");
      const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= TOLERANCE_S;
      const valid = given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
      if (!fresh || !valid) return json({ error: "invalid signature" }, 401);

      let input: unknown;
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) return json({ error: "body must be a JSON object" }, 400);
      const r = await deps.engine.run(cfg.flow, input as Record<string, unknown>, { signal: req.signal });
      if (!r.ok) return json({ error: r.error }, r.error === TOO_MANY_RUNS ? 503 : 500);
      return json({ ok: r.value.ok, runId: r.value.runId, output: r.value.output?.output, data: r.value.output?.data });
    },
  };
}
