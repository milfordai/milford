import { z } from "zod";
import type { NodeDef } from "../registry.js";
import { render, resolve, scopeOf } from "../template.js";

export const NONE = "none_of_these";

const config = z.object({
  provider: z.string(),
  kind: z.enum(["choice", "score", "noul"]),
  /** The question. Templated. */
  prompt: z.string(),
  /** What to evaluate. Templated; defaults to the whole run input as JSON. */
  state: z.string().optional(),
  /** Choices (`choice`) or ordered levels (`score`). A single `{{path}}` pulls an array from the run input. */
  options: z.union([z.array(z.string()), z.string()]).optional(),
  /** Below this confidence a `choice` decision becomes `none_of_these` and `gated` is set. */
  minConfidence: z.number().min(0).max(1).optional(),
  model: z.string().optional(),
});

/** A typed decision through a named provider. Choice decisions always include `none_of_these`. */
export const decisionNode: NodeDef<z.infer<typeof config>> = {
  configSchema: config.refine((c) => c.kind === "noul" || c.options !== undefined, { message: "options are required for choice and score" }),
  requires: (c) => ({ provider: c.provider, capability: "decide" }),
  // A provider outage, reconnect or a model that failed to produce a decision is retryable; template and
  // options errors are flow problems and are not.
  retryable: (r) => !r.error?.startsWith("unknown template variable") && !r.error?.startsWith("options") && !r.error?.startsWith("score needs"),
  async run(ctx, up) {
    const c = ctx.config;
      const scope = scopeOf(ctx.input, up);
      const q = render(c.prompt, scope);
      if (!q.ok) return { success: false, error: q.error };
      const st = c.state === undefined ? { ok: true as const, value: JSON.stringify(ctx.input) } : render(c.state, scope);
      if (!st.ok) return { success: false, error: st.error };

      let options: string[] | undefined;
      if (c.options !== undefined) {
        const raw = typeof c.options === "string" ? resolve(c.options.match(/^\{\{\s*(.+?)\s*\}\}$/)?.[1] ?? "", scope) : c.options;
        if (!Array.isArray(raw) || !raw.every((o) => typeof o === "string")) return { success: false, error: "options must be a list of strings" };
        options = raw as string[];
        if (c.kind === "choice" && !options.includes(NONE)) options = [...options, NONE];
        if (c.kind === "score" && options.length < 2) return { success: false, error: "score needs at least two levels" };
      }

      const res = await ctx.providers.decide(c.provider, { kind: c.kind, prompt: q.value, state: st.value, options, model: c.model, signal: ctx.signal });
      if (!res.ok) return { success: false, error: res.error };
      const d = res.value;
      const gated = c.minConfidence !== undefined && d.confidence !== undefined && d.confidence < c.minConfidence;
      const choice = d.kind === "choice" && (gated || d.choice === undefined) ? NONE : d.choice;
      const answer = choice ?? d.score ?? d.noul;
      return {
        success: true,
        output: String(answer),
        data: { kind: d.kind, question: q.value, options, choice, score: d.score, noul: d.noul, probabilities: d.probabilities, confidence: d.confidence, gated, provider: c.provider },
      };
  },
};
