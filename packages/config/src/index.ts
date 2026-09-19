import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Flow, ProviderConfig, Result } from "@milfordai/core";
import { parse } from "yaml";
import { z } from "zod";

const Condition = z.object({ path: z.string(), op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]), value: z.unknown() });
export const FlowSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  cache: z.object({ mode: z.literal("direct"), ttlMs: z.number().positive() }).optional(),
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
  /** Chat and webhook entry points. Each is validated by @milfordai/channels when the server starts. */
  channels: z.array(z.looseObject({ id: z.string(), type: z.string(), flow: z.string() })).default([]),
  /** Other MCP servers that `mcp` nodes can call (Streamable HTTP). */
  mcpServers: z.array(z.object({ id: z.string(), url: z.string(), headers: z.record(z.string(), z.string()).default({}) })).default([]),
  /** The `milford-mcp` server. Nothing is exposed unless listed in `expose`. */
  mcp: z.object({
    /** Flow ids exposed as MCP tools. */
    expose: z.array(z.string()).default([]),
    transport: z.enum(["stdio", "http"]).default("stdio"),
    port: z.number().int().default(8090),
    host: z.string().default("0.0.0.0"),
    auth: z.object({ tokens: z.array(z.string()).default([]) }).default({ tokens: [] }),
  }).default({ expose: [], transport: "stdio", port: 8090, host: "0.0.0.0", auth: { tokens: [] } }),
  /** Limits shared by the HTTP server, the MCP server and the channels. */
  run: z.object({
    /** Per-run timeout in milliseconds. */
    timeoutMs: z.number().positive().default(60_000),
    /** Runs allowed at once. Further runs are rejected. */
    maxConcurrentRuns: z.number().int().positive().default(64),
  }).default({ timeoutMs: 60_000, maxConcurrentRuns: 64 }),
  server: z.object({
    port: z.number().int().default(8080),
    auth: z.object({ tokens: z.array(z.string()).default([]) }).default({ tokens: [] }),
    /** How long a completed run is kept for `Idempotency-Key` replays. */
    idempotencyTtlMs: z.number().positive().default(600_000),
    /** Largest accepted request body. */
    maxBodyBytes: z.number().int().positive().default(1_000_000),
    /** History of finished runs, listed at `GET /v1/runs`. */
    runs: z.object({
      store: z.enum(["memory", "file"]).default("memory"),
      /** JSON-lines file for `store: file`, relative to the config file. */
      path: z.string().default("milford-runs.jsonl"),
      /** Runs kept and listed. */
      max: z.number().int().positive().default(200),
      /** `trace` keeps status, timing and errors. `full` also keeps inputs and node results. */
      record: z.enum(["trace", "full"]).default("trace"),
    }).default({ store: "memory", path: "milford-runs.jsonl", max: 200, record: "trace" }),
  }).default({ port: 8080, auth: { tokens: [] }, idempotencyTtlMs: 600_000, maxBodyBytes: 1_000_000, runs: { store: "memory", path: "milford-runs.jsonl", max: 200, record: "trace" } }),
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

/** Parses YAML text (flow files may be YAML or JSON), interpolates env vars, validates, and reads the referenced flow files (relative to `baseDir`). */
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
      json = parse(readFile(file)); // JSON is valid YAML, so existing .json flows keep working
    } catch (e) {
      return { ok: false, error: `flow file ${f.file}: ${(e as Error).message}` };
    }
    const flow = FlowSchema.safeParse(f.id ? { id: f.id, ...(json as object) } : json);
    if (!flow.success) return { ok: false, error: `flow file ${f.file}: ${flow.error.issues.map((i) => `${i.path.join(".") || "flow"}: ${i.message}`).join("; ")}` };
    flows.push(flow.data as Flow);
  }
  // A new object, because the defaults zod fills in are shared between parses.
  const { server } = parsed.data;
  const config = { ...parsed.data, server: { ...server, runs: { ...server.runs, path: resolve(baseDir, server.runs.path) } } };
  return { ok: true, value: { config, providers: parsed.data.providers as ProviderConfig[], flows } };
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Result<Loaded> {
  try {
    return parseConfig(readFileSync(path, "utf8"), dirname(resolve(path)), env);
  } catch (e) {
    return { ok: false, error: `cannot read config ${path}: ${(e as Error).message}` };
  }
}
