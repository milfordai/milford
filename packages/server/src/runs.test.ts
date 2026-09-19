import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "@milfordai/core";
import { describe, expect, it } from "vitest";
import { fileRunStore, memoryRunStore, summarize, toRecord } from "./runs.js";

const result = (id: string, ok = true): RunResult => ({ ok, runId: id, nodes: { a: { status: "done", ms: 12.4, result: { success: true, output: "secret text", data: { pii: 1 } } }, b: { status: ok ? "done" : "error", ms: 3, result: { success: ok, error: ok ? undefined : "boom" } } }, output: { success: true, output: "secret text" } });
const record = (id: string, flow = "f", mode: "trace" | "full" = "trace") => toRecord(flow, new Date("2026-01-01T00:00:00Z"), 20.6, result(id, id !== "bad"), { name: "Ann" }, mode);

describe("toRecord", () => {
  it("keeps only the trace by default, because outputs and inputs can be sensitive", () => {
    const r = record("r1");
    expect(r).toMatchObject({ runId: "r1", flow: "f", startedAt: "2026-01-01T00:00:00.000Z", ms: 21, ok: true });
    expect(r.nodes.a).toEqual({ status: "done", ms: 12, error: undefined });
    expect(JSON.stringify(r)).not.toContain("secret text");
    expect(JSON.stringify(r)).not.toContain("Ann");
  });

  it("keeps inputs and node results in full mode", () => {
    const r = record("r1", "f", "full");
    expect(r.input).toEqual({ name: "Ann" });
    expect(r.nodes.a?.result).toMatchObject({ output: "secret text" });
    expect(r.output).toMatchObject({ output: "secret text" });
  });

  it("summarizes", () => {
    expect(summarize(record("r1"))).toEqual({ runId: "r1", flow: "f", startedAt: "2026-01-01T00:00:00.000Z", ms: 21, ok: true, nodes: 2 });
  });
});

describe("memoryRunStore", () => {
  it("lists newest first, filters by flow, limits, and keeps only the newest max", () => {
    const s = memoryRunStore(3);
    for (const [id, flow] of [["r1", "a"], ["r2", "b"], ["r3", "a"], ["r4", "b"]] as const) s.save(record(id, flow));
    expect(s.list().map((r) => r.runId)).toEqual(["r4", "r3", "r2"]); // r1 was dropped
    expect(s.list({ flow: "a" }).map((r) => r.runId)).toEqual(["r3"]);
    expect(s.list({ limit: 1 }).map((r) => r.runId)).toEqual(["r4"]);
    expect(s.get("r2")?.runId).toBe("r2");
    expect(s.get("r1")).toBeUndefined();
  });
});

describe("fileRunStore", () => {
  it("survives a restart, and skips a corrupt line", () => {
    const path = join(mkdtempSync(join(tmpdir(), "runs-")), "sub", "runs.jsonl");
    const first = fileRunStore(path);
    first.save(record("r1"));
    first.save(record("bad"));
    writeFileSync(path, readFileSync(path, "utf8") + "{not json\n");
    const second = fileRunStore(path);
    expect(second.list().map((r) => r.runId)).toEqual(["bad", "r1"]);
    expect(second.get("bad")?.ok).toBe(false);
    second.save(record("r3"));
    expect(fileRunStore(path).list().map((r) => r.runId)).toEqual(["r3", "bad", "r1"]);
  });

  it("loads only the newest max runs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "runs-")), "runs.jsonl");
    const s = fileRunStore(path, 10);
    for (let i = 0; i < 5; i++) s.save(record(`r${i}`));
    expect(fileRunStore(path, 2).list().map((r) => r.runId)).toEqual(["r4", "r3"]);
  });
});
