import type { ProviderFactory } from "@milfordai/core";
import { z } from "zod";
import { DECISION_SYSTEM, decisionPrompt, decisionSchema, err, parseDecision, postJson } from "./util.js";

const config = z.object({ apiKey: z.string(), baseUrl: z.string().default("https://api.anthropic.com"), model: z.string().optional(), maxTokens: z.number().int().default(1024) });

export const anthropic: ProviderFactory = (raw, { fetch }) => {
  const parsed = config.safeParse(raw);
  if (!parsed.success) return err(parsed.error.message);
  const settings = parsed.data;
  const call = (model: string | undefined, body: object, signal?: AbortSignal) => {
    const resolvedModel = model ?? settings.model;
    if (!resolvedModel) return Promise.resolve(err("no model set on the provider or the request"));
    return postJson(fetch, `${settings.baseUrl.replace(/\/$/, "")}/v1/messages`, { "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01" }, { model: resolvedModel, max_tokens: settings.maxTokens, ...body }, signal);
  };
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "anthropic",
      capabilities: ["chat", "decide"],
      async chat(request) {
        const result = await call(request.model, { ...(request.system && { system: request.system }), messages: [{ role: "user", content: request.prompt }] }, request.signal);
        if (!result.ok) return result;
        const text = (result.value?.content as { type: string; text?: string }[] | undefined)?.filter((block) => block.type === "text").map((block) => block.text).join("");
        return text === undefined ? err("response had no content") : { ok: true, value: { text } };
      },
      /** Forced tool use with a JSON schema. */
      async decide(request) {
        const result = await call(request.model, {
          system: DECISION_SYSTEM,
          messages: [{ role: "user", content: decisionPrompt(request) }],
          tools: [{ name: "decision", description: "Record the decision.", input_schema: decisionSchema(request) }],
          tool_choice: { type: "tool", name: "decision" },
        }, request.signal);
        if (!result.ok) return result;
        const block = (result.value?.content as { type: string; input?: unknown }[] | undefined)?.find((part) => part.type === "tool_use");
        return block ? parseDecision(request, block.input) : err("response had no tool call");
      },
    },
  };
};
