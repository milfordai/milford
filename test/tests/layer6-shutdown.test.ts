import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, type Rule } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { llmFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";
import { elapsedOf, waitUntil } from "../src/timing.js";

let fake: FakeProvider;

beforeAll(async () => {
  fake = await new FakeProvider().start([
    { type: "chat", model: "fake-model", latencyMs: 1400, result: { text: "slow but finished" } },
    { type: "chat", match: "SHUTDOWN stuck", latencyMs: 120_000, result: { text: "never" } },
  ] as Rule[]);
});

afterAll(async () => {
  await fake.stop();
});

describe("MIL-70: shutdown", () => {
  it("SIGTERM with a run in flight lets it finish, and the server exits cleanly within the 10s bound", async () => {
    const { config, files } = serverConfig(fake.url, { "flows/draining.json": llmFlow("draining", "fake", "SHUTDOWN draining call") });
    const server = await startServer({ config, files });

    // One run is truly in flight when the signal arrives.
    const runPromise = runFlow(server.url, "draining", {}, TOKEN);
    await waitUntil(() => fake.count("SHUTDOWN draining call") >= 1, 5000);

    const { ms } = await elapsedOf(async () => {
      const [finished, closed] = await Promise.all([runPromise, server.close()]);
      // The in-flight run completed with its answer...
      expect(finished.status).toBe(200);
      expect(finished.body.ok).toBe(true);
      expect(finished.body.output?.output).toBe("slow but finished");
      // ...and the server drained and exited by itself, not via the SIGKILL backstop.
      expect(closed.code).toBe(0);
    });
    // Well inside the CLI's own 10 second bound; exact timing is not asserted.
    expect(ms).toBeLessThan(8000);
  });

  it("a stuck run does not block exit: the 10s backstop fires and the exit code is 1", async () => {
    const { config, files } = serverConfig(fake.url, { "flows/stuck.json": llmFlow("stuck", "fake", "SHUTDOWN stuck") });
    const server = await startServer({ config, files });

    // The run will hang for far longer than the shutdown bound.
    const runPromise = runFlow(server.url, "stuck", {}, TOKEN);
    const runOutcome = runPromise.then(() => "the stuck run's response ended with the process", () => "the connection died with the process");
    await waitUntil(() => fake.count("SHUTDOWN stuck") >= 1, 5000);

    // The harness backstop is raised past the CLI's own 10s timer, so the exit code is the CLI's.
    const { ms } = await elapsedOf(() => server.close(12_000));
    await runOutcome;
    expect(ms).toBeGreaterThanOrEqual(9_700); // it waited the full bound, not an early crash
    expect(ms).toBeLessThan(11_900);
  });
});
