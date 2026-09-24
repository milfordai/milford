import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { runCli, startServer, type RunningServer } from "../src/harness.js";
import { openaiProvider, serverConfig, TOKEN } from "../src/fixtures.js";
import { cacheFlow, helloFlow, llmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";

let fake: FakeProvider;
let first: RunningServer;
let second: RunningServer;
let dir: string;
let runsPath: string;
let setup: { config: string; files: Record<string, string> };
let persistedRunId: string;
let idemRunId: string;

beforeAll(async () => {
  fake = await new FakeProvider().start([
    // Two matched failures open the breaker in the first generation; the default keeps failing for
    // the second generation's fresh call.
    { type: "chat-error", match: "RESTART breaker", model: "m-brk", status: 500, body: "brk down" },
    { type: "chat-error", match: "RESTART breaker", model: "m-brk", status: 500, body: "brk down" },
    { type: "chat-error", model: "m-brk", status: 500, body: "brk still down" },
    { type: "chat", model: "m-solid", result: { text: "answer from solid" } },
  ] as Rule[]);

  dir = mkdtempSync(join(tmpdir(), "milford-test-restart-"));
  runsPath = join(dir, "milford-runs.jsonl");
  setup = serverConfig(fake.url, {
    "flows/hello.json": helloFlow,
    "flows/cached.json": cacheFlow,
    "flows/breaker.json": llmFlow("breaker", "brk", "RESTART breaker"),
  }, {
    providers: [
      openaiProvider("brk", fake.url, "m-brk", 'circuitBreaker: { failures: 2, resetMs: 60000 }, fallback: ["solid"]'),
      openaiProvider("solid", fake.url, "m-solid"),
    ],
    // An absolute path, so the `runs` CLI reads the same file from its own temp config dir.
    server: [`runs: { store: file, path: ${JSON.stringify(runsPath)} }`],
  });

  first = await startServer({ ...setup, dir });
});

afterAll(async () => {
  await first.close();
  await second?.close();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("MIL-70: restart", () => {
  it("generation one: a run, a cache fill, a breaker opening and an idempotent replay", async () => {
    // One run lands in the file store.
    const persisted = await runFlow(first.url, "hello", { name: "Persist" }, TOKEN);
    expect(persisted.body.ok).toBe(true);
    persistedRunId = persisted.body.runId;

    // The cache fills, and the breaker opens after two failures (resetMs 60s, so it stays open).
    const miss = await runFlow(first.url, "cached", { n: 1 }, TOKEN);
    expect(miss.body.cache).toBe("miss");
    const breakerOne = await runFlow(first.url, "breaker", {}, TOKEN);
    expect(breakerOne.body.output?.output).toBe("answer from solid");
    const breakerTwo = await runFlow(first.url, "breaker", {}, TOKEN);
    expect(breakerTwo.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brk"')).toBe(2);
    const breakerOpen = await runFlow(first.url, "breaker", {}, TOKEN);
    expect(breakerOpen.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brk"')).toBe(2); // open: fail fast, no provider call

    // An idempotent replay is remembered.
    const idemFirst = await runFlow(first.url, "hello", { name: "Idem" }, TOKEN, { "Idempotency-Key": "restart-key" });
    expect(idemFirst.headers.get("idempotent-replayed")).toBeNull();
    idemRunId = idemFirst.body.runId;
    const idemReplay = await runFlow(first.url, "hello", { name: "Idem" }, TOKEN, { "Idempotency-Key": "restart-key" });
    expect(idemReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(idemReplay.body.runId).toBe(idemRunId);
  });

  it("generation two: the file history survives, a corrupt line is skipped, and in-memory state starts empty", async () => {
    await first.close();
    appendFileSync(runsPath, "this line is corrupt, not a run record\n");

    second = await startServer({ ...setup, dir });

    // The first generation's run is still listed; the corrupt line was skipped, not fatal.
    const list = await (await fetch(`${second.url}/v1/runs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { runs: Array<{ runId: string }> };
    expect(list.runs.some((run) => run.runId === persistedRunId)).toBe(true);

    // The run cache is empty: the same input is a miss again.
    const missAgain = await runFlow(second.url, "cached", { n: 1 }, TOKEN);
    expect(missAgain.body.cache).toBe("miss");

    // The idempotency store is empty: the same key is not a replay, and gets a new run id.
    const idemFresh = await runFlow(second.url, "hello", { name: "Idem" }, TOKEN, { "Idempotency-Key": "restart-key" });
    expect(idemFresh.headers.get("idempotent-replayed")).toBeNull();
    expect(idemFresh.body.runId).not.toBe(idemRunId);

    // The circuit breaker is closed again: the primary is called (and still fails, to the fallback).
    expect(fake.count('"m-brk"')).toBe(2);
    const breakerFresh = await runFlow(second.url, "breaker", {}, TOKEN);
    expect(breakerFresh.body.output?.output).toBe("answer from solid");
    expect(fake.count('"m-brk"')).toBe(3); // the fresh generation called the primary again
  });

  it("the runs CLI reads the same file store after the restart", async () => {
    const { code, out } = await runCli("runs", setup.config, { files: setup.files });
    expect(code).toBe(0);
    expect(out).toContain(persistedRunId);
    expect(out).toContain("hello");
    expect(out).toContain("ok");
    expect(out).not.toContain("corrupt");

    const shown = await runCli(["runs", "show", persistedRunId], setup.config, { files: setup.files });
    expect(shown.code).toBe(0);
    const record = JSON.parse(shown.out) as { runId: string; flow: string; nodes: Record<string, unknown> };
    expect(record.runId).toBe(persistedRunId);
    expect(record.flow).toBe("hello");
    expect(Object.keys(record.nodes)).toContain("greet");

    const missing = await runCli(["runs", "show", "does-not-exist"], setup.config, { files: setup.files });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('unknown run "does-not-exist"');
  });
});
