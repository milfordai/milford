import { createHmac, timingSafeEqual } from "node:crypto";
import { TOO_MANY_RUNS } from "@milfordai/core";
import { z } from "zod";
import type { Channel, ChannelDeps } from "./types.js";

export const webhookConfig = z.object({ id: z.string(), type: z.literal("webhook"), flow: z.string(), secret: z.string().min(16) });
const TOLERANCE_S = 300;

/**
 * Signed inbound webhook. The caller sends `x-milford-timestamp` (unix seconds) and
 * `x-milford-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 * The JSON body becomes the flow input; the response carries the flow output.
 */
export function webhook(config: z.infer<typeof webhookConfig>, deps: ChannelDeps): Channel {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    id: config.id,
    type: "webhook",
    start: async () => {},
    stop: async () => {},
    async handle(request) {
      const raw = await request.text();
      const ts = request.headers.get("x-milford-timestamp") ?? "";
      const given = (request.headers.get("x-milford-signature") ?? "").replace(/^sha256=/, "");
      const want = createHmac("sha256", config.secret).update(`${ts}.${raw}`).digest("hex");
      const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= TOLERANCE_S;
      // Hex first: any other shape would make timingSafeEqual throw on the byte length, not fail the check.
      const valid = /^[0-9a-f]{64}$/.test(given) && timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(want, "hex"));
      if (!fresh || !valid) return json({ error: "invalid signature" }, 401);

      let input: unknown;
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) return json({ error: "body must be a JSON object" }, 400);

      const result = await deps.engine.run(config.flow, input as Record<string, unknown>, { signal: request.signal });
      if (!result.ok) return json({ error: result.error }, result.error === TOO_MANY_RUNS ? 503 : 500);
      return json({ ok: result.value.ok, runId: result.value.runId, output: result.value.output?.output, data: result.value.output?.data });
    },
  };
}
