import type { ProviderFactory } from "@milfordai/core";
import { z } from "zod";
import { DECISION_SYSTEM, decisionPrompt, decisionSchema, err, parseDecision, postJson } from "./util.js";

const config = z.object({ apiKey: z.string().optional(), baseUrl: z.string().default("https://api.openai.com/v1"), model: z.string().optional() });

/** OpenAI, and any OpenAI-compatible server (Groq, Perplexity, local) through `baseUrl`. */
export const openai: ProviderFactory = (raw, { fetch }) => {
  const parsed = config.safeParse(raw);
  if (!parsed.success) return err(parsed.error.message);
  const settings = parsed.data;
  const call = (model: string | undefined, messages: unknown[], extra: object, signal?: AbortSignal) => {
    const resolvedModel = model ?? settings.model;
    if (!resolvedModel) return Promise.resolve(err("no model set on the provider or the request"));
    return postJson(fetch, `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}, { model: resolvedModel, messages, ...extra }, signal);
  };
  const content = (response: any): string | undefined => response?.choices?.[0]?.message?.content;
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "openai",
      capabilities: ["chat", "decide"],
      async chat(request) {
        const messages = [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }];
        const result = await call(request.model, messages, {}, request.signal);
        if (!result.ok) return result;
        const text = content(result.value);
        return text === undefined ? err("response had no content") : { ok: true, value: { text } };
      },
      async decide(request) {
        const messages = [{ role: "system", content: DECISION_SYSTEM }, { role: "user", content: decisionPrompt(request) }];
        const result = await call(request.model, messages, { response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: decisionSchema(request) } } }, request.signal);
        if (!result.ok) return result;
        try {
          return parseDecision(request, JSON.parse(content(result.value) ?? ""));
        } catch {
          return err("decision was not valid JSON");
        }
      },
    },
  };
};
