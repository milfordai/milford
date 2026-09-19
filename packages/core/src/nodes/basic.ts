import { z } from "zod";
import type { NodeDef } from "../registry.js";
import { render, renderDeep, scopeOf } from "../template.js";
import type { NodeResult } from "../types.js";

const fail = (error: string): NodeResult => ({ success: false, error });
const joinOutputs = (up: Record<string, NodeResult>) => Object.values(up).map((r) => r.output ?? "").join("\n\n");

export const inputNode: NodeDef = {
  async run(ctx) {
    return { success: true, output: JSON.stringify(ctx.input), data: ctx.input };
  },
};

export const promptNode: NodeDef<{ template: string }> = {
  configSchema: z.object({ template: z.string() }),
  async run(ctx, up) {
    const r = render(ctx.config.template, scopeOf(ctx.input, up));
    return r.ok ? { success: true, output: r.value } : fail(r.error);
  },
};

export const outputNode: NodeDef<{ template?: string }> = {
  configSchema: z.object({ template: z.string().optional() }),
  async run(ctx, up) {
    const results = Object.entries(up);
    const data = results.length === 1 ? results[0]![1].data : Object.fromEntries(results.map(([id, r]) => [id, r.data]));
    if (ctx.config.template === undefined) return { success: true, output: joinOutputs(up), data };
    const r = render(ctx.config.template, scopeOf(ctx.input, up));
    return r.ok ? { success: true, output: r.value, data } : fail(r.error);
  },
};

const httpConfig = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  /** "controller" is reserved for mesh setups; v1 always executes locally. */
  egress: z.enum(["local", "controller"]).default("local"),
});

export const httpNode: NodeDef<z.infer<typeof httpConfig>> = {
  configSchema: httpConfig,
  async run(ctx, up) {
    const scope = scopeOf(ctx.input, up);
    const req = renderDeep({ url: ctx.config.url, headers: ctx.config.headers, body: ctx.config.body }, scope);
    if (!req.ok) return fail(req.error);
    const { url, headers, body } = req.value as { url: string; headers: Record<string, string>; body?: unknown };
    try {
      const res = await ctx.fetch(url, {
        method: ctx.config.method,
        headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: ctx.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { success: res.ok, output: text, data: { status: res.status, body: parsed }, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};
