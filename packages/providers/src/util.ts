import type { DecideRequest, Decision, Result } from "@milfordai/core";

export const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

export async function postJson(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Result<any>> {
  try {
    const response = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal });
    const text = await response.text();
    if (!response.ok) return err(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return err("response was not JSON");
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

// --- Shared by LLM-backed `decide` (openai, anthropic) --------------------

export const DECISION_SYSTEM = "You make one typed decision about the given state. Reply only with JSON that matches the schema.";

export function decisionSchema(request: DecideRequest): Record<string, unknown> {
  const confidence = { type: "number", minimum: 0, maximum: 1 };
  if (request.kind === "choice") return { type: "object", properties: { choice: { type: "string", enum: request.options }, confidence }, required: ["choice", "confidence"], additionalProperties: false };
  if (request.kind === "score") return { type: "object", properties: { score: { type: "number", minimum: 0, maximum: (request.options?.length ?? 2) - 1 }, confidence }, required: ["score", "confidence"], additionalProperties: false };
  return { type: "object", properties: { probability: { type: "number", minimum: 0, maximum: 1 } }, required: ["probability"], additionalProperties: false };
}

export function decisionPrompt(request: DecideRequest): string {
  const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
  const options = request.kind === "choice"
    ? `\nOptions:\n${request.options!.map((option) => `- ${option}`).join("\n")}`
    : request.kind === "score"
      ? `\nLevels (0 = first):\n${request.options!.map((option, index) => `${index}: ${option}`).join("\n")}`
      : "\nGive the probability (0..1) that the answer is yes.";
  return `Question: ${request.prompt}${options}\n\nState:\n${state}`;
}

export function parseDecision(request: DecideRequest, raw: unknown): Result<Decision> {
  const parsed = raw as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return err("decision was not an object");

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : undefined;
  if (request.kind === "choice") return typeof parsed.choice === "string" && request.options?.includes(parsed.choice) ? { ok: true, value: { kind: "choice", choice: parsed.choice, confidence } } : err("decision choice is not one of the options");
  if (request.kind === "score") return typeof parsed.score === "number" ? { ok: true, value: { kind: "score", score: parsed.score, confidence } } : err("decision has no score");
  return typeof parsed.probability === "number" ? { ok: true, value: { kind: "noul", noul: parsed.probability } } : err("decision has no probability");
}
