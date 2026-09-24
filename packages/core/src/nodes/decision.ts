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
  configSchema: config.refine((config) => config.kind === "noul" || config.options !== undefined, { message: "options are required for choice and score" }),
  requires: (config) => ({ provider: config.provider, capability: "decide" }),
  // A provider outage, reconnect or a model that failed to produce a decision is retryable; template and
  // options errors are flow problems and are not.
  retryable: (result) => !result.error?.startsWith("unknown template variable") && !result.error?.startsWith("options") && !result.error?.startsWith("score needs"),
  async run(ctx, upstream) {
    const config = ctx.config;
    const scope = scopeOf(ctx.input, upstream);

    const renderedPrompt = render(config.prompt, scope);
    if (!renderedPrompt.ok) return { success: false, error: renderedPrompt.error };

    const renderedState = config.state === undefined ? { ok: true as const, value: JSON.stringify(ctx.input) } : render(config.state, scope);
    if (!renderedState.ok) return { success: false, error: renderedState.error };

    let options: string[] | undefined;
    if (config.options !== undefined) {
      const rawOptions = typeof config.options === "string" ? resolve(config.options.match(/^\{\{\s*(.+?)\s*\}\}$/)?.[1] ?? "", scope) : config.options;
      if (!Array.isArray(rawOptions) || !rawOptions.every((option) => typeof option === "string")) return { success: false, error: "options must be a list of strings" };
      options = rawOptions as string[];
      if (config.kind === "choice" && !options.includes(NONE)) options = [...options, NONE];
      if (config.kind === "score" && options.length < 2) return { success: false, error: "score needs at least two levels" };
    }

    const response = await ctx.providers.decide(config.provider, { kind: config.kind, prompt: renderedPrompt.value, state: renderedState.value, options, model: config.model, signal: ctx.signal });
    if (!response.ok) return { success: false, error: response.error };

    const decision = response.value;
    const gated = config.minConfidence !== undefined && decision.confidence !== undefined && decision.confidence < config.minConfidence;
    const choice = decision.kind === "choice" && (gated || decision.choice === undefined) ? NONE : decision.choice;
    const answer = choice ?? decision.score ?? decision.noul;
    return {
      success: true,
      output: String(answer),
      data: { kind: decision.kind, question: renderedPrompt.value, options, choice, score: decision.score, noul: decision.noul, probabilities: decision.probabilities, confidence: decision.confidence, gated, provider: config.provider },
    };
  },
};
