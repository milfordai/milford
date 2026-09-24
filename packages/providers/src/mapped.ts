import type { DecideRequest, Decision, Result } from "@milfordai/core";
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

export function decisionFrom(request: DecideRequest, response: unknown, map: Mapping): Result<Decision> {
  const at = (path?: string) => (path ? jsonPath(response, path) : undefined);
  let probabilities = at(map.probabilities) as Record<string, number> | number[] | undefined;
  if (Array.isArray(probabilities)) {
    const options = request.options ?? [];
    if (probabilities.length !== options.length) return err("probabilities do not line up with the options");
    probabilities = Object.fromEntries(options.map((option, index) => [option, (probabilities as number[])[index]!]));
  }

  const num = (value: unknown) => (typeof value === "number" ? value : undefined);
  if (request.kind === "choice") {
    let choice = at(map.choice) as string | undefined;
    if (choice === undefined && probabilities) choice = Object.entries(probabilities).sort((entryA, entryB) => entryB[1] - entryA[1])[0]?.[0];
    if (choice === undefined) return err("response had no choice");
    const confidence = num(at(map.confidence)) ?? (probabilities ? probabilities[choice] : undefined);
    return { ok: true, value: { kind: "choice", choice, probabilities: probabilities as Record<string, number> | undefined, confidence } };
  }
  if (request.kind === "score") {
    const score = num(at(map.score));
    return score === undefined ? err("response had no score") : { ok: true, value: { kind: "score", score, probabilities: probabilities as Record<string, number> | undefined, confidence: num(at(map.confidence)) } };
  }
  const noul = num(at(map.noul));
  return noul === undefined ? err("response had no noul value") : { ok: true, value: { kind: "noul", noul } };
}
