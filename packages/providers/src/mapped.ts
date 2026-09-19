import { renderDeep, type DecideRequest, type Decision, type Result } from "@loage/core";
import { z } from "zod";
import { jsonPath } from "./jsonpath.js";
import { err } from "./util.js";

/** JSONPath expressions that pull a Decision (or chat text) out of a response. */
export const mapSchema = z.object({
  choice: z.string().optional(),
  /** Object of option -> probability, or an array aligned with the request options. */
  probabilities: z.string().optional(),
  confidence: z.string().optional(),
  score: z.string().optional(),
  noul: z.string().optional(),
  text: z.string().optional(),
});
export type Mapping = z.infer<typeof mapSchema>;

export const fillRequest = (template: unknown, req: DecideRequest | { prompt: string; system?: string; model?: string }): Result<unknown> =>
  renderDeep(template, { ...req, signal: undefined });

export function decisionFrom(req: DecideRequest, res: unknown, map: Mapping): Result<Decision> {
  const at = (p?: string) => (p ? jsonPath(res, p) : undefined);
  let probabilities = at(map.probabilities) as Record<string, number> | number[] | undefined;
  if (Array.isArray(probabilities)) {
    const opts = req.options ?? [];
    if (probabilities.length !== opts.length) return err("probabilities do not line up with the options");
    probabilities = Object.fromEntries(opts.map((o, i) => [o, (probabilities as number[])[i]!]));
  }
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  if (req.kind === "choice") {
    let choice = at(map.choice) as string | undefined;
    if (choice === undefined && probabilities) choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (choice === undefined) return err("response had no choice");
    const confidence = num(at(map.confidence)) ?? (probabilities ? probabilities[choice] : undefined);
    return { ok: true, value: { kind: "choice", choice, probabilities: probabilities as Record<string, number> | undefined, confidence } };
  }
  if (req.kind === "score") {
    const score = num(at(map.score));
    return score === undefined ? err("response had no score") : { ok: true, value: { kind: "score", score, probabilities: probabilities as Record<string, number> | undefined, confidence: num(at(map.confidence)) } };
  }
  const noul = num(at(map.noul));
  return noul === undefined ? err("response had no noul value") : { ok: true, value: { kind: "noul", noul } };
}
