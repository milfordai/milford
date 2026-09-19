import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Flow, ProviderConfig, Result } from "@loage/core";
import { parse } from "yaml";
import { z } from "zod";

const Condition = z.object({ path: z.string(), op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]), value: z.unknown() });
export const FlowSchema = z.object({
  id: z.string(),
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
    join: z.enum(["any", "all"]).optional(),
    retry: z.object({ attempts: z.number().int().positive(), backoffMs: z.number().nonnegative().optional() }).optional(),
    timeoutMs: z.number().positive().optional(),
    cache: z.boolean().optional(),
    meta: z.unknown().optional(),
  })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), when: Condition.optional() })),
});

export const ConfigSchema = z.object({
  providers: z.array(z.looseObject({
    id: z.string(),
    type: z.string(),
    fallback: z.array(z.string()).optional(),
    circuitBreaker: z.object({ failures: z.number().int().positive(), resetMs: z.number().positive() }).optional(),
    rateLimit: z.object({ perSecond: z.number().positive(), burst: z.number().positive().optional() }).optional(),
  })).default([]),
  flows: z.array(z.object({ id: z.string().optional(), file: z.string() })).default([]),
  server: z.object({
    port: z.number().int().default(8080),
    auth: z.object({ tokens: z.array(z.string()).default([]) }).default({ tokens: [] }),
    /** Per-run timeout in milliseconds. */
    runTimeoutMs: z.number().positive().default(60_000),
    /** Runs allowed at once; more get 503 with Retry-After. */
    maxConcurrentRuns: z.number().int().positive().default(64),
    /** Largest accepted request body. */
    maxBodyBytes: z.number().int().positive().default(1_000_000),
  }).default({ port: 8080, auth: { tokens: [] }, runTimeoutMs: 60_000, maxConcurrentRuns: 64, maxBodyBytes: 1_000_000 }),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Replaces `${VAR}` in every string. Unset variables are collected and reported together. */
export function interpolate(value: unknown, env: Record<string, string | undefined>, missing: Set<string> = new Set()): unknown {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => (env[name] ?? (missing.add(name), "")));
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, missing)]));
  return value;
}

export type Loaded = { config: Config; providers: ProviderConfig[]; flows: Flow[] };

/** Parses YAML text, interpolates env vars, validates, and reads the referenced flow files (relative to `baseDir`). */
export function parseConfig(text: string, baseDir: string, env: Record<string, string | undefined> = process.env, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Result<Loaded> {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (e) {
    return { ok: false, error: `config is not valid YAML: ${(e as Error).message}` };
  }
  const missing = new Set<string>();
  const filled = interpolate(raw, env, missing);
  if (missing.size) return { ok: false, error: `environment variables not set: ${[...missing].join(", ")}` };
  const parsed = ConfigSchema.safeParse(filled);
  if (!parsed.success) return { ok: false, error: `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}` };

  const flows: Flow[] = [];
  for (const f of parsed.data.flows) {
    const file = resolve(baseDir, f.file);
    let json: unknown;
    try {
      json = JSON.parse(readFile(file));
    } catch (e) {
      return { ok: false, error: `flow file ${f.file}: ${(e as Error).message}` };
    }
    const flow = FlowSchema.safeParse(f.id ? { id: f.id, ...(json as object) } : json);
    if (!flow.success) return { ok: false, error: `flow file ${f.file}: ${flow.error.issues.map((i) => `${i.path.join(".") || "flow"}: ${i.message}`).join("; ")}` };
    flows.push(flow.data as Flow);
  }
  return { ok: true, value: { config: parsed.data, providers: parsed.data.providers as ProviderConfig[], flows } };
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Result<Loaded> {
  try {
    return parseConfig(readFileSync(path, "utf8"), dirname(resolve(path)), env);
  } catch (e) {
    return { ok: false, error: `cannot read config ${path}: ${(e as Error).message}` };
  }
}
