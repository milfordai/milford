import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { helloFlow, llmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";
import { waitUntil } from "../src/timing.js";

let fake: FakeProvider;
let server: RunningServer; // maxConcurrentRuns: 1, so a freed slot is observable

const runsList = async (): Promise<Array<{ runId: string; ok: boolean }>> => {
  const res = await fetch(`${server.url}/v1/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as { runs: Array<{ runId: string; ok: boolean }> }).runs;
};

const failedRuns = async () => (await runsList()).filter((run) => !run.ok);

beforeAll(async () => {
  fake = await new FakeProvider().start([
    { type: "chat", model: "fake-model", latencyMs: 1200, result: { text: "slow answer" } },
  ] as Rule[]);
  const { config, files } = serverConfig(fake.url, {
    "flows/slow.json": llmFlow("slow", "fake", "CANCEL slow call"),
    "flows/hello.json": helloFlow,
  }, { run: ["maxConcurrentRuns: 1"] });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("MIL-70: cancellation", () => {
  it("a JSON client that disconnects mid-run cancels the run and frees its slot", async () => {
    const failedBefore = (await failedRuns()).length;
    const abort = new AbortController();
    const runPromise = fetch(`${server.url}/v1/flows/slow/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
      signal: abort.signal,
    });
    // Wait until the provider call is in flight, so the disconnect truly interrupts a run.
    await waitUntil(() => fake.count("CANCEL slow call") >= 1, 5000);
    abort.abort();
    await runPromise.then(() => { throw new Error("the aborted request should not have answered"); }, () => "aborted as expected");

    // The cancelled run finishes with an aborted node and lands in the history.
    await waitUntil(async () => (await failedRuns()).length > failedBefore, 5000);
    const failed = await failedRuns();
    const record = await (await fetch(`${server.url}/v1/runs/${failed[0]!.runId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      ok: boolean;
      nodes: Record<string, { status: string; error?: string }>;
    };
    expect(record.ok).toBe(false);
    expect(record.nodes.llm?.status).toBe("error");
    expect(record.nodes.llm?.error).toMatch(/abort|prematurely closed/i);
    expect(record.nodes.out?.status).toBe("skipped");

    // The slot was freed: the next run is served instead of a busy 503.
    const next = await runFlow(server.url, "hello", { name: "Freed" }, TOKEN);
    expect(next.status).toBe(200);
    expect(next.body.ok).toBe(true);
  });

  it("an event-stream client that disconnects mid-run cancels the run and frees its slot", async () => {
    const failedBefore = (await failedRuns()).length;
    const abort = new AbortController();
    const res = await fetch(`${server.url}/v1/flows/slow/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ input: {} }),
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    // Events flow while the run is live; read one to prove the stream started.
    const reader = res.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.value).toBeDefined();
    await waitUntil(() => fake.count("CANCEL slow call") >= 2, 5000);
    abort.abort();
    await reader.read().catch(() => "stream closed by the abort");

    // The run is cancelled: an aborted node lands in the history.
    await waitUntil(async () => (await failedRuns()).length > failedBefore, 5000);
    const record = await (await fetch(`${server.url}/v1/runs/${(await failedRuns())[0]!.runId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      nodes: Record<string, { status: string; error?: string }>;
    };
    expect(record.nodes.llm?.status).toBe("error");
    expect(record.nodes.llm?.error).toMatch(/abort/i);

    // The slot was freed again.
    const next = await runFlow(server.url, "hello", { name: "Freed again" }, TOKEN);
    expect(next.status).toBe(200);
    expect(next.body.ok).toBe(true);
  });
});
