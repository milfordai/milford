import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "@milfordai/core";
import { describe, expect, it } from "vitest";
import { fileRunStore, memoryRunStore, summarize, toRecord } from "../src/runs.js";

const result = (runId: string, ok = true): RunResult => ({ ok, runId, nodes: { a: { status: "done", ms: 12.4, result: { success: true, output: "secret text", data: { pii: 1 } } }, b: { status: ok ? "done" : "error", ms: 3, result: { success: ok, error: ok ? undefined : "boom" } } }, output: { success: true, output: "secret text" } });
const record = (runId: string, flow = "f", mode: "trace" | "full" = "trace") => toRecord(flow, new Date("2026-01-01T00:00:00Z"), 20.6, result(runId, runId !== "bad"), { name: "Ann" }, mode);

describe("toRecord", () => {
  it("keeps only the trace by default, because outputs and inputs can be sensitive", () => {
    const record = toRecord("f", new Date("2026-01-01T00:00:00Z"), 20.6, result("r1"), { name: "Ann" }, "trace");
    expect(record).toMatchObject({ runId: "r1", flow: "f", startedAt: "2026-01-01T00:00:00.000Z", ms: 21, ok: true });
    expect(record.nodes.a).toEqual({ status: "done", ms: 12, error: undefined });
    expect(JSON.stringify(record)).not.toContain("secret text");
    expect(JSON.stringify(record)).not.toContain("Ann");
  });

  it("keeps inputs and node results in full mode", () => {
    const record = toRecord("f", new Date("2026-01-01T00:00:00Z"), 20.6, result("r1"), { name: "Ann" }, "full");
    expect(record.input).toEqual({ name: "Ann" });
    expect(record.nodes.a?.result).toMatchObject({ output: "secret text" });
    expect(record.output).toMatchObject({ output: "secret text" });
  });

  it("summarizes", () => {
    expect(summarize(record("r1"))).toEqual({ runId: "r1", flow: "f", startedAt: "2026-01-01T00:00:00.000Z", ms: 21, ok: true, nodes: 2 });
  });
});

describe("memoryRunStore", () => {
  it("lists newest first, filters by flow, limits, and keeps only the newest max", () => {
    const store = memoryRunStore(3);
    for (const [runId, flow] of [["r1", "a"], ["r2", "b"], ["r3", "a"], ["r4", "b"]] as const) store.save(record(runId, flow));
    expect(store.list().map((entry) => entry.runId)).toEqual(["r4", "r3", "r2"]); // r1 was dropped
    expect(store.list({ flow: "a" }).map((entry) => entry.runId)).toEqual(["r3"]);
    expect(store.list({ limit: 1 }).map((entry) => entry.runId)).toEqual(["r4"]);
    expect(store.get("r2")?.runId).toBe("r2");
    expect(store.get("r1")).toBeUndefined();
  });
});

describe("fileRunStore", () => {
  it("survives a restart, and skips a corrupt line", () => {
    const path = join(mkdtempSync(join(tmpdir(), "runs-")), "sub", "runs.jsonl");
    const firstStore = fileRunStore(path);
    firstStore.save(record("r1"));
    firstStore.save(record("bad"));
    writeFileSync(path, readFileSync(path, "utf8") + "{not json\n");
    const secondStore = fileRunStore(path);
    expect(secondStore.list().map((entry) => entry.runId)).toEqual(["bad", "r1"]);
    expect(secondStore.get("bad")?.ok).toBe(false);
    secondStore.save(record("r3"));
    expect(fileRunStore(path).list().map((entry) => entry.runId)).toEqual(["r3", "bad", "r1"]);
  });

  it("loads only the newest max runs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "runs-")), "runs.jsonl");
    const store = fileRunStore(path, 10);
    for (let index = 0; index < 5; index++) store.save(record(`r${index}`));
    expect(fileRunStore(path, 2).list().map((entry) => entry.runId)).toEqual(["r4", "r3"]);
  });
});
