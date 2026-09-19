import type { Capability, ProviderFactory } from "@loage/core";
import { z } from "zod";
import { jsonPath } from "./jsonpath.js";
import { decisionFrom, fillRequest, mapSchema } from "./mapped.js";
import { err, postJson } from "./util.js";

const config = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  capabilities: z.array(z.enum(["chat", "decide"])).default(["decide"]),
  /** Body template. Variables: kind, prompt, state, options, model (and system for chat). A lone "{{options}}" keeps its array type. */
  request: z.unknown().default({ prompt: "{{prompt}}", state: "{{state}}", options: "{{options}}" }),
  map: mapSchema.default({}),
});

/** Any JSON endpoint, such as a local classifier: request template in, JSONPath mapping out. */
export const http: ProviderFactory = (raw, { fetch }) => {
  const p = config.safeParse(raw);
  if (!p.success) return err(p.error.message);
  const c = p.data;
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "http",
      capabilities: c.capabilities as Capability[],
      async decide(req) {
        const body = fillRequest(c.request, req);
        if (!body.ok) return body;
        const r = await postJson(fetch, c.url, c.headers, body.value, req.signal);
        return r.ok ? decisionFrom(req, r.value, c.map) : r;
      },
      async chat(req) {
        const body = fillRequest(c.request, req);
        if (!body.ok) return body;
        const r = await postJson(fetch, c.url, c.headers, body.value, req.signal);
        if (!r.ok) return r;
        const text = c.map.text ? jsonPath(r.value, c.map.text) : undefined;
        return typeof text === "string" ? { ok: true, value: { text } } : err("response had no text");
      },
    },
  };
};
