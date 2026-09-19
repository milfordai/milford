import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunResult } from "@milfordai/core";

export type RunNode = { status: string; ms?: number; error?: string; result?: unknown };

/** One finished run, as kept for history. */
export type RunRecord = {
  runId: string;
  flow: string;
  /** ISO time the run started. */
  startedAt: string;
  ms: number;
  ok: boolean;
  nodes: Record<string, RunNode>;
  /** Only with `record: full`. */
  input?: unknown;
  output?: unknown;
};

export type RunSummary = Pick<RunRecord, "runId" | "flow" | "startedAt" | "ms" | "ok"> & { nodes: number };

/** Where finished runs are kept. Implement it to store history somewhere else. */
export interface RunStore {
  save(record: RunRecord): void;
  /** Newest first. */
  list(options?: { flow?: string; limit?: number }): RunRecord[];
  get(runId: string): RunRecord | undefined;
}

export const summarize = (r: RunRecord): RunSummary => ({ runId: r.runId, flow: r.flow, startedAt: r.startedAt, ms: r.ms, ok: r.ok, nodes: Object.keys(r.nodes).length });

/**
 * The record of a run. By default only the trace is kept (status, timing and errors), because inputs and node
 * outputs can hold personal data or secrets. With `full`, the input and every node result are kept too.
 */
export function toRecord(flow: string, startedAt: Date, ms: number, result: RunResult, input: unknown, mode: "trace" | "full"): RunRecord {
  const nodes = Object.fromEntries(
    Object.entries(result.nodes).map(([id, n]) => [id, { status: n.status, ms: n.ms === undefined ? undefined : Math.round(n.ms), error: n.result?.error, ...(mode === "full" && { result: n.result }) }]),
  );
  return { runId: result.runId, flow, startedAt: startedAt.toISOString(), ms: Math.round(ms), ok: result.ok, nodes, ...(mode === "full" && { input, output: result.output }) };
}

/** The newest `max` runs, in memory. Lost on restart. */
export function memoryRunStore(max = 200): RunStore {
  const records: RunRecord[] = []; // newest first
  return {
    save(r) {
      records.unshift(r);
      if (records.length > max) records.length = max;
    },
    list({ flow, limit = 50 } = {}) {
      return records.filter((r) => !flow || r.flow === flow).slice(0, limit);
    },
    get: (id) => records.find((r) => r.runId === id),
  };
}

/**
 * Keeps runs in a JSON-lines file, so history survives a restart and `milford-server runs` can read it.
 * The newest `max` runs are served from memory. One instance per file.
 */
export function fileRunStore(path: string, max = 200): RunStore {
  const memory = memoryRunStore(max);
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-max)) {
      try { memory.save(JSON.parse(line) as RunRecord); } catch { /* skip a torn or corrupt line */ }
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  return {
    ...memory,
    save(r) {
      // ponytail: the file grows without bound. Add rotation or a size cap when history gets large.
      appendFileSync(path, JSON.stringify(r) + "\n");
      memory.save(r);
    },
  };
}
