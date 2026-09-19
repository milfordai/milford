import type { DecideRequest, Decision, Result } from "@milfordai/core";

export const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

export async function postJson(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Result<any>> {
  try {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal });
    const text = await res.text();
    if (!res.ok) return err(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return err("response was not JSON");
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- Shared by LLM-backed `decide` (openai, anthropic) --------------------

export const DECISION_SYSTEM = "You make one typed decision about the given state. Reply only with JSON that matches the schema.";

export function decisionSchema(req: DecideRequest): Record<string, unknown> {
  const confidence = { type: "number", minimum: 0, maximum: 1 };
  if (req.kind === "choice") return { type: "object", properties: { choice: { type: "string", enum: req.options }, confidence }, required: ["choice", "confidence"], additionalProperties: false };
  if (req.kind === "score") return { type: "object", properties: { score: { type: "number", minimum: 0, maximum: (req.options?.length ?? 2) - 1 }, confidence }, required: ["score", "confidence"], additionalProperties: false };
  return { type: "object", properties: { probability: { type: "number", minimum: 0, maximum: 1 } }, required: ["probability"], additionalProperties: false };
}

export function decisionPrompt(req: DecideRequest): string {
  const state = typeof req.state === "string" ? req.state : JSON.stringify(req.state);
  const opts = req.kind === "choice" ? `\nOptions:\n${req.options!.map((o) => `- ${o}`).join("\n")}` : req.kind === "score" ? `\nLevels (0 = first):\n${req.options!.map((o, i) => `${i}: ${o}`).join("\n")}` : "\nGive the probability (0..1) that the answer is yes.";
  return `Question: ${req.prompt}${opts}\n\nState:\n${state}`;
}

export function parseDecision(req: DecideRequest, raw: unknown): Result<Decision> {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return err("decision was not an object");
  const confidence = typeof o.confidence === "number" ? o.confidence : undefined;
  if (req.kind === "choice") return typeof o.choice === "string" && req.options?.includes(o.choice) ? { ok: true, value: { kind: "choice", choice: o.choice, confidence } } : err("decision choice is not one of the options");
  if (req.kind === "score") return typeof o.score === "number" ? { ok: true, value: { kind: "score", score: o.score, confidence } } : err("decision has no score");
  return typeof o.probability === "number" ? { ok: true, value: { kind: "noul", noul: o.probability } } : err("decision has no probability");
}
