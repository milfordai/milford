import type { DecideRequest, Decision, ProviderFactory, Result } from "@milfordai/core";
import { z } from "zod";
import { err, postJson } from "./util.js";

const config = z.object({ apiKey: z.string(), baseUrl: z.string().default("https://api.typesafe.ai"), model: z.string().default("jev-latest") });

const question = (request: DecideRequest) =>
  request.kind === "choice" ? { type: "choice", instructions: request.prompt, criteria: Object.fromEntries((request.options ?? []).map((option) => [option, null])) }
  : request.kind === "score" ? { type: "score", instructions: request.prompt, criteria: request.options }
  : { type: "noul", instructions: request.prompt };

function answer(kind: DecideRequest["kind"], payload: any): Result<Decision> {
  if (!payload || payload.type !== kind) return err("unexpected answer type");
  if (kind === "choice") return { ok: true, value: { kind, choice: payload.choice, probabilities: payload.probabilities, confidence: payload.confidence } };
  if (kind === "score") return { ok: true, value: { kind, score: payload.score, probabilities: payload.probabilities, confidence: payload.confidence } };
  return { ok: true, value: { kind, noul: payload.noul } };
}

/** Jev (TypeSafe System One). One adapter among several; nothing in core depends on it. */
export const typesafe: ProviderFactory = (raw, { fetch }) => {
  const parsed = config.safeParse(raw);
  if (!parsed.success) return err(parsed.error.message);
  const settings = parsed.data;

  /** One request, many questions over the same state. */
  const ask = async (requests: DecideRequest[], signal?: AbortSignal): Promise<Result<Decision[]>> => {
    const questions = Object.fromEntries(requests.map((request, index) => [`q${index}`, question(request)]));
    const response = await postJson(fetch, `${settings.baseUrl.replace(/\/$/, "")}/v1/systemone`, { authorization: `Bearer ${settings.apiKey}` }, { state: requests[0]!.state, model: requests[0]!.model ?? settings.model, questions }, signal);
    if (!response.ok) return response;

    const out: Decision[] = [];
    for (const [index, request] of requests.entries()) {
      const decision = answer(request.kind, response.value?.answers?.[`q${index}`]);
      if (!decision.ok) return decision;
      out.push(decision.value);
    }
    return { ok: true, value: out };
  };

  return {
    ok: true,
    value: {
      id: raw.id,
      type: "typesafe",
      capabilities: ["decide"],
      async decide(request) {
        const result = await ask([request], request.signal);
        return result.ok ? { ok: true, value: result.value[0]! } : result;
      },
      /** Server-side batching: requests over the same state share one call. */
      async decideMany(requests) {
        const groups = new Map<string, number[]>();
        requests.forEach((request, index) => groups.set(JSON.stringify(request.state), [...(groups.get(JSON.stringify(request.state)) ?? []), index]));
        const out: Decision[] = new Array(requests.length);
        const results = await Promise.all([...groups.values()].map(async (indices) => ({ indices, result: await ask(indices.map((index) => requests[index]!), requests[indices[0]!]!.signal) })));
        for (const { indices, result } of results) {
          if (!result.ok) return result;
          indices.forEach((index, position) => (out[index] = result.value[position]!));
        }
        return { ok: true, value: out };
      },
    },
  };
};
