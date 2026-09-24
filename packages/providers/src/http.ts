import { renderDeep, type Capability, type ProviderFactory } from "@milfordai/core";
import { z } from "zod";
import { jsonPath } from "./jsonpath.js";
import { decisionFrom, mapSchema } from "./mapped.js";
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
  const parsed = config.safeParse(raw);
  if (!parsed.success) return err(parsed.error.message);
  const settings = parsed.data;
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "http",
      capabilities: settings.capabilities as Capability[],
      async decide(request) {
        const body = renderDeep(settings.request, request);
        if (!body.ok) return body;
        const result = await postJson(fetch, settings.url, settings.headers, body.value, request.signal);
        return result.ok ? decisionFrom(request, result.value, settings.map) : result;
      },
      async chat(request) {
        const body = renderDeep(settings.request, request);
        if (!body.ok) return body;
        const result = await postJson(fetch, settings.url, settings.headers, body.value, request.signal);
        if (!result.ok) return result;
        const text = settings.map.text ? jsonPath(result.value, settings.map.text) : undefined;
        return typeof text === "string" ? { ok: true, value: { text } } : err("response had no text");
      },
    },
  };
};
