import type { ProviderFactory } from "@loage/core";
import { z } from "zod";
import { DECISION_SYSTEM, decisionPrompt, decisionSchema, err, parseDecision, postJson } from "./util.js";

const config = z.object({ apiKey: z.string(), baseUrl: z.string().default("https://api.anthropic.com"), model: z.string().optional(), maxTokens: z.number().int().default(1024) });

export const anthropic: ProviderFactory = (raw, { fetch }) => {
  const p = config.safeParse(raw);
  if (!p.success) return err(p.error.message);
  const c = p.data;
  const call = (model: string | undefined, body: object, signal?: AbortSignal) => {
    const m = model ?? c.model;
    if (!m) return Promise.resolve(err("no model set on the provider or the request"));
    return postJson(fetch, `${c.baseUrl.replace(/\/$/, "")}/v1/messages`, { "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" }, { model: m, max_tokens: c.maxTokens, ...body }, signal);
  };
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "anthropic",
      capabilities: ["chat", "decide"],
      async chat(req) {
        const r = await call(req.model, { ...(req.system && { system: req.system }), messages: [{ role: "user", content: req.prompt }] }, req.signal);
        if (!r.ok) return r;
        const text = (r.value?.content as { type: string; text?: string }[] | undefined)?.filter((b) => b.type === "text").map((b) => b.text).join("");
        return text === undefined ? err("response had no content") : { ok: true, value: { text } };
      },
      /** Forced tool use with a JSON schema. */
      async decide(req) {
        const r = await call(req.model, {
          system: DECISION_SYSTEM,
          messages: [{ role: "user", content: decisionPrompt(req) }],
          tools: [{ name: "decision", description: "Record the decision.", input_schema: decisionSchema(req) }],
          tool_choice: { type: "tool", name: "decision" },
        }, req.signal);
        if (!r.ok) return r;
        const block = (r.value?.content as { type: string; input?: unknown }[] | undefined)?.find((b) => b.type === "tool_use");
        return block ? parseDecision(req, block.input) : err("response had no tool call");
      },
    },
  };
};
