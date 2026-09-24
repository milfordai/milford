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

const httpConfig = z
  .object({
    url: z.string(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    /** Origins a templated `url` may target, e.g. `https://api.example.com`. Required when `url` contains `{{`. */
    allow: z.array(z.string()).optional(),
    /** Largest accepted response body. A larger body fails the node instead of being buffered whole. */
    maxResponseBytes: z.number().int().positive().default(10_000_000),
  })
  .refine((config) => !config.url.includes("{{") || !!config.allow?.length, { message: "a templated url needs an allow list of origins", path: ["allow"] });

/** Reads the body up to `maxResponseBytes`; a larger body fails the node instead of being buffered whole. */
async function readBody(response: Response, maxResponseBytes: number): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response body exceeded maxResponseBytes (${maxResponseBytes} bytes)`);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export const httpNode: NodeDef<z.infer<typeof httpConfig>> = {
  configSchema: httpConfig,
  // Transient infrastructure: timeouts, reconnects, rate limits (429), request timeouts (408) and 5xx answers.
  // Other 4xx answers are the caller's bug.
  retryable: (result) => {
    const error = result.error;
    if (error === undefined) return false;
    if (error === "HTTP 408" || error === "HTTP 429") return true; // worth another try, like a 5xx
    return !/^HTTP 4\d\d$/.test(error);
  },
  async run(ctx, upstream) {
    const scope = scopeOf(ctx.input, upstream);
    const rendered = renderDeep({ url: ctx.config.url, headers: ctx.config.headers, body: ctx.config.body }, scope);
    if (!rendered.ok) return fail(rendered.error);

    const { url, headers, body } = rendered.value as { url: string; headers: Record<string, string>; body?: unknown };

    // Rendered header values come from run input: a CR/LF in one would splice new headers onto the request.
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) return fail(`header "${name}" must be a string without control characters`);
    }

    // A templated url can only target an allowed origin, so run input cannot steer the request elsewhere.
    if (ctx.config.allow) {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return fail(`url "${url}" is not a valid absolute URL`);
      }
      if (!ctx.config.allow.includes(origin)) return fail(`url origin "${origin}" is not in the allow list`);
    }

    try {
      const response = await ctx.fetch(url, {
        method: ctx.config.method,
        headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: ctx.signal,
      });
      const text = await readBody(response, ctx.config.maxResponseBytes);
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { success: response.ok, output: text, data: { status: response.status, body: parsed }, error: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
