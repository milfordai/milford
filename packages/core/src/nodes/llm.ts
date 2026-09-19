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
  requires: (c) => ({ provider: c.provider, capability: "chat" }),
  async run(ctx, up) {
    const c = ctx.config;
    let prompt: string;
    if (c.prompt === undefined) prompt = Object.values(up).map((r) => r.output ?? "").join("\n\n");
    else {
      const r = render(c.prompt, scopeOf(ctx.input, up));
      if (!r.ok) return { success: false, error: r.error };
      prompt = r.value;
    }
    if (c.maxInputChars !== undefined) prompt = prompt.slice(0, c.maxInputChars);
    const res = await ctx.providers.chat(c.provider, { prompt, system: c.system ?? (c.preset && presets[c.preset]), model: c.model, signal: ctx.signal });
    return res.ok ? ({ success: true, output: res.value.text } satisfies NodeResult) : { success: false, error: res.error };
  },
};
