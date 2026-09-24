import { describe, expect, it } from "vitest";
import { runCli } from "../src/harness.js";
import { helloFlow } from "../src/flows.js";
import { serverConfig } from "../src/fixtures.js";

const base = serverConfig("http://127.0.0.1:1", { "flows/hello.json": helloFlow });

describe("MIL-62: config and CLI", () => {
  it("validate accepts a valid config and reports its flow count", async () => {
    const result = await runCli("validate", base.config, { files: base.files });

    expect(result.code).toBe(0);
    expect(result.out).toContain("is valid (1 flow(s)");
  });

  it("reports every unset interpolation variable", async () => {
    const config = `
providers:
  - { id: fake, type: openai, baseUrl: "\${MILFORD_TEST_BASE_URL}", model: "\${MILFORD_TEST_MODEL}" }
flows:
  - { file: flows/hello.json }
server:
  port: PORT
  auth:
    tokens: ["\${MILFORD_TEST_TOKEN}"]
`;
    const result = await runCli("validate", config, {
      files: { "flows/hello.json": JSON.stringify(helloFlow) },
      env: {
        MILFORD_TEST_BASE_URL: undefined as never,
        MILFORD_TEST_MODEL: undefined as never,
        MILFORD_TEST_TOKEN: undefined as never,
      },
    });

    expect(result.code).toBe(1);
    expect(result.out).toContain("environment variables not set");
    expect(result.out).toContain("MILFORD_TEST_BASE_URL");
    expect(result.out).toContain("MILFORD_TEST_MODEL");
    expect(result.out).toContain("MILFORD_TEST_TOKEN");
  });

  it("interpolates set and quoted values", async () => {
    const config = `
providers:
  - { id: fake, type: openai, baseUrl: "\${MILFORD_TEST_BASE_URL}", model: "\${MILFORD_TEST_MODEL}" }
flows:
  - { file: flows/hello.json }
server:
  port: PORT
  auth:
    tokens: ["\${MILFORD_TEST_TOKEN}"]
`;
    const result = await runCli("validate", config, {
      files: { "flows/hello.json": JSON.stringify(helloFlow) },
      env: {
        MILFORD_TEST_BASE_URL: "http://127.0.0.1:1",
        MILFORD_TEST_MODEL: "model with spaces",
        MILFORD_TEST_TOKEN: "token: with spaces",
      },
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("is valid (1 flow(s)");
  });

  it("rejects invalid config values with actionable paths", async () => {
    const invalid = [
      [base.config.replace("server:\n", "run:\n  timeoutMs: 0\nserver:\n"), "run.timeoutMs"],
      [base.config.replace("server:\n", "run:\n  maxConcurrentRuns: 1.5\nserver:\n"), "run.maxConcurrentRuns"],
      [base.config.replace("runs: { store: memory }", "runs: { store: disk }"), "server.runs.store"],
    ];

    for (const [config, path] of invalid) {
      const result = await runCli("validate", config, { files: base.files });
      expect(result.code, config).toBe(1);
      expect(result.out, config).toContain(path);
    }
  });

  it("openapi prints a per-flow operation", async () => {
    const result = await runCli("openapi", base.config, { files: base.files });
    expect(result.code).toBe(0);

    const spec = JSON.parse(result.out) as { paths: Record<string, { post?: { operationId?: string } }> };
    expect(spec.paths["/v1/flows/hello/run"]?.post?.operationId).toBe("runHello");
  });

  it("runs reports the memory-store limitation", async () => {
    const result = await runCli("runs", base.config, { files: base.files });

    expect(result.code).toBe(1);
    expect(result.out).toContain("runs are kept in memory");
  });

  it("runs and runs show read a file store, with a useful missing-run error", async () => {
    const record = {
      runId: "run-cli-1",
      flow: "hello",
      startedAt: "2026-01-01T00:00:00.000Z",
      ms: 2,
      ok: true,
      nodes: { greet: { status: "done", ms: 1 } },
    };
    const config = `${base.config.replace("  runs: { store: memory }", "  runs: { store: file, path: history/runs.jsonl }")}\n`;
    const files = { ...base.files, "history/runs.jsonl": `${JSON.stringify(record)}\ncorrupt line\n` };

    const list = await runCli("runs", config, { files });
    expect(list.code).toBe(0);
    expect(list.out).toContain("run-cli-1");
    expect(list.out).toContain("hello");
    expect(list.out).not.toContain("corrupt");

    const show = await runCli(["runs", "show", "run-cli-1"], config, { files });
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out)).toMatchObject({ runId: "run-cli-1", flow: "hello" });

    const missing = await runCli(["runs", "show", "missing"], config, { files });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('unknown run "missing"');
  });
});
