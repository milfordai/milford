import { readFileSync } from "node:fs";
import type { Engine } from "@milfordai/core";
import { parse } from "yaml";

type Json = Record<string, any>;
export type FlowInfo = ReturnType<Engine["flows"]>[number];

/** The hand-written spec that ships next to this package: shared schemas, errors, auth and the fixed routes. */
export const baseSpec = (): Json => parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

/** `classify-error` -> `ClassifyError`, for operation ids and schema names. */
const pascal = (id: string) => id.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");

/**
 * The base spec with one typed operation per flow, so generated clients get a real request type per flow.
 * The generic `POST /v1/flows/{id}/run` is replaced by these operations. Built from the loaded flows, so it
 * cannot drift from the config.
 */
export function buildOpenApi(flows: FlowInfo[], base: Json = baseSpec()): Json {
  const spec: Json = structuredClone(base);
  const generic = spec.paths["/v1/flows/{id}/run"].post;
  delete spec.paths["/v1/flows/{id}/run"];
  const idem = generic.parameters.filter((p: Json) => p.in === "header");
  const names = new Set<string>();
  for (const f of flows) {
    const name = pascal(f.id);
    if (names.has(name)) throw new Error(`flows "${f.id}" and another flow map to the same operation name "run${name}"`);
    names.add(name);
    const input = f.input ?? { type: "object", additionalProperties: true };
    const hasRequired = Array.isArray(f.input?.required) && f.input.required.length > 0;
    spec.components.schemas[`${name}Input`] = input;
    spec.components.schemas[`${name}Request`] = {
      type: "object",
      properties: { input: { $ref: `#/components/schemas/${name}Input` } },
      ...(hasRequired && { required: ["input"] }),
    };
    spec.paths[`/v1/flows/${f.id}/run`] = {
      post: {
        ...generic,
        operationId: `run${name}`,
        summary: f.description ?? `Run the ${f.id} flow`,
        parameters: idem,
        requestBody: { required: hasRequired, content: { "application/json": { schema: { $ref: `#/components/schemas/${name}Request` } } } },
        responses: Object.fromEntries(Object.entries(generic.responses).filter(([code]) => code !== "404")), // the flow exists
      },
    };
  }
  return spec;
}
