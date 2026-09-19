import type { DecideRequest, Decision, ProviderFactory, Result } from "@milfordai/core";
import { z } from "zod";
import { err, postJson } from "./util.js";

const config = z.object({ apiKey: z.string(), baseUrl: z.string().default("https://api.typesafe.ai"), model: z.string().default("jev-latest") });

const question = (r: DecideRequest) =>
  r.kind === "choice" ? { type: "choice", instructions: r.prompt, criteria: Object.fromEntries((r.options ?? []).map((o) => [o, null])) }
  : r.kind === "score" ? { type: "score", instructions: r.prompt, criteria: r.options }
  : { type: "noul", instructions: r.prompt };

function answer(kind: DecideRequest["kind"], a: any): Result<Decision> {
  if (!a || a.type !== kind) return err("unexpected answer type");
  if (kind === "choice") return { ok: true, value: { kind, choice: a.choice, probabilities: a.probabilities, confidence: a.confidence } };
  if (kind === "score") return { ok: true, value: { kind, score: a.score, probabilities: a.probabilities, confidence: a.confidence } };
  return { ok: true, value: { kind, noul: a.noul } };
}

/** Jev (TypeSafe System One). One adapter among several; nothing in core depends on it. */
export const typesafe: ProviderFactory = (raw, { fetch }) => {
  const p = config.safeParse(raw);
  if (!p.success) return err(p.error.message);
  const c = p.data;

  /** One request, many questions over the same state. */
  const ask = async (reqs: DecideRequest[], signal?: AbortSignal): Promise<Result<Decision[]>> => {
    const questions = Object.fromEntries(reqs.map((r, i) => [`q${i}`, question(r)]));
    const res = await postJson(fetch, `${c.baseUrl.replace(/\/$/, "")}/v1/systemone`, { authorization: `Bearer ${c.apiKey}` }, { state: reqs[0]!.state, model: reqs[0]!.model ?? c.model, questions }, signal);
    if (!res.ok) return res;
    const out: Decision[] = [];
    for (const [i, r] of reqs.entries()) {
      const d = answer(r.kind, res.value?.answers?.[`q${i}`]);
      if (!d.ok) return d;
      out.push(d.value);
    }
    return { ok: true, value: out };
  };

  return {
    ok: true,
    value: {
      id: raw.id,
      type: "typesafe",
      capabilities: ["decide"],
      async decide(req) {
        const r = await ask([req], req.signal);
        return r.ok ? { ok: true, value: r.value[0]! } : r;
      },
      /** Server-side batching: requests over the same state share one call. */
      async decideMany(reqs) {
        const groups = new Map<string, number[]>();
        reqs.forEach((r, i) => groups.set(JSON.stringify(r.state), [...(groups.get(JSON.stringify(r.state)) ?? []), i]));
        const out: Decision[] = new Array(reqs.length);
        const results = await Promise.all([...groups.values()].map(async (idx) => ({ idx, r: await ask(idx.map((i) => reqs[i]!), reqs[idx[0]!]!.signal) })));
        for (const { idx, r } of results) {
          if (!r.ok) return r;
          idx.forEach((i, k) => (out[i] = r.value[k]!));
        }
        return { ok: true, value: out };
      },
    },
  };
};
