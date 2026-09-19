import type { ProviderFactory } from "@milford/core";
import { z } from "zod";
import { DECISION_SYSTEM, decisionPrompt, decisionSchema, err, parseDecision, postJson } from "./util.js";

const config = z.object({ apiKey: z.string().optional(), baseUrl: z.string().default("https://api.openai.com/v1"), model: z.string().optional() });

/** OpenAI, and any OpenAI-compatible server (Groq, Perplexity, local) through `baseUrl`. */
export const openai: ProviderFactory = (raw, { fetch }) => {
  const p = config.safeParse(raw);
  if (!p.success) return err(p.error.message);
  const c = p.data;
  const call = (model: string | undefined, messages: unknown[], extra: object, signal?: AbortSignal) => {
    const m = model ?? c.model;
    if (!m) return Promise.resolve(err("no model set on the provider or the request"));
    return postJson(fetch, `${c.baseUrl.replace(/\/$/, "")}/chat/completions`, c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, { model: m, messages, ...extra }, signal);
  };
  const content = (r: any): string | undefined => r?.choices?.[0]?.message?.content;
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "openai",
      capabilities: ["chat", "decide"],
      async chat(req) {
        const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }];
        const r = await call(req.model, messages, {}, req.signal);
        if (!r.ok) return r;
        const text = content(r.value);
        return text === undefined ? err("response had no content") : { ok: true, value: { text } };
      },
      async decide(req) {
        const messages = [{ role: "system", content: DECISION_SYSTEM }, { role: "user", content: decisionPrompt(req) }];
        const r = await call(req.model, messages, { response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: decisionSchema(req) } } }, req.signal);
        if (!r.ok) return r;
        try {
          return parseDecision(req, JSON.parse(content(r.value) ?? ""));
        } catch {
          return err("decision was not valid JSON");
        }
      },
    },
  };
};
