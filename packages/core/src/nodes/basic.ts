import { z } from "zod";
import type { NodeDef } from "../registry.js";
import { render, renderDeep, scopeOf } from "../template.js";
import type { NodeResult } from "../types.js";

const fail = (error: string): NodeResult => ({ success: false, error });
const joinOutputs = (upstream: Record<string, NodeResult>) => Object.values(upstream).map((result) => result.output ?? "").join("\n\n");

export const inputNode: NodeDef = {
  retryable: () => false,
  async run(ctx) {
    return { success: true, output: JSON.stringify(ctx.input), data: ctx.input };
  },
};

export const promptNode: NodeDef<{ template: string }> = {
  configSchema: z.object({ template: z.string() }),
  // A template error is a flow problem: retrying it fails the same way.
  retryable: () => false,
  async run(ctx, upstream) {
    const rendered = render(ctx.config.template, scopeOf(ctx.input, upstream));
    return rendered.ok ? { success: true, output: rendered.value } : fail(rendered.error);
  },
};

export const outputNode: NodeDef<{ template?: string }> = {
  configSchema: z.object({ template: z.string().optional() }),
  retryable: () => false,
  async run(ctx, upstream) {
    const results = Object.entries(upstream);
    const data = results.length === 1 ? results[0]![1].data : Object.fromEntries(results.map(([nodeId, result]) => [nodeId, result.data]));
    if (ctx.config.template === undefined) return { success: true, output: joinOutputs(upstream), data };

    const rendered = render(ctx.config.template, scopeOf(ctx.input, upstream));
    return rendered.ok ? { success: true, output: rendered.value, data } : fail(rendered.error);
  },
};

const httpConfig = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
});

export const httpNode: NodeDef<z.infer<typeof httpConfig>> = {
  configSchema: httpConfig,
  // Transient infrastructure: timeouts, reconnects, rate limits and 5xx answers. A 4xx is the caller's bug.
  retryable: (result) => result.error !== undefined && !/^HTTP 4\d\d$/.test(result.error),
  async run(ctx, upstream) {
    const scope = scopeOf(ctx.input, upstream);
    const rendered = renderDeep({ url: ctx.config.url, headers: ctx.config.headers, body: ctx.config.body }, scope);
    if (!rendered.ok) return fail(rendered.error);

    const { url, headers, body } = rendered.value as { url: string; headers: Record<string, string>; body?: unknown };
    try {
      const response = await ctx.fetch(url, {
        method: ctx.config.method,
        headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: ctx.signal,
      });
      const text = await response.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { success: response.ok, output: text, data: { status: response.status, body: parsed }, error: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
