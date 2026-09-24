import { z } from "zod";
import type { NodeDef } from "../registry.js";
import { presets } from "../presets.js";
import { render, scopeOf } from "../template.js";
import type { NodeResult } from "../types.js";

const config = z.object({
  provider: z.string(),
  model: z.string().optional(),
  system: z.string().optional(),
  preset: z.enum(Object.keys(presets) as [string, ...string[]]).optional(),
  /** Template for the user message. Defaults to the upstream outputs joined together. */
  prompt: z.string().optional(),
  /** Truncates the input before the call. Unset means no truncation. */
  maxInputChars: z.number().int().positive().optional(),
});

/** One chat call through a named provider. No loop, no tools. */
export const llmNode: NodeDef<z.infer<typeof config>> = {
  configSchema: config,
  requires: (config) => ({ provider: config.provider, capability: "chat" }),
  // A provider outage or reconnect is worth a retry; a template error is a flow problem and is not.
  retryable: (result) => !result.error?.startsWith("unknown template variable"),
  async run(ctx, upstream) {
    const config = ctx.config;
    let prompt: string;
    if (config.prompt === undefined) {
      prompt = Object.values(upstream).map((result) => result.output ?? "").join("\n\n");
    } else {
      const rendered = render(config.prompt, scopeOf(ctx.input, upstream));
      if (!rendered.ok) return { success: false, error: rendered.error };
      prompt = rendered.value;
    }

    if (config.maxInputChars !== undefined) prompt = prompt.slice(0, config.maxInputChars);

    const response = await ctx.providers.chat(config.provider, { prompt, system: config.system ?? (config.preset && presets[config.preset]), model: config.model, signal: ctx.signal });
    return response.ok ? ({ success: true, output: response.value.text } satisfies NodeResult) : { success: false, error: response.error };
  },
};
