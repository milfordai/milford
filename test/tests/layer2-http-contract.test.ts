import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider } from "../src/fake-provider.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { helloFlow } from "../src/flows.js";
import { runFlow } from "../src/client.js";

let fake: FakeProvider;
let server: RunningServer;

beforeAll(async () => {
  fake = await new FakeProvider().start([]);
  const { config, files } = serverConfig(fake.url, { "flows/hello.json": helloFlow });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("HTTP API contract", () => {
  it("GET /health is open and reports ok", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /v1/flows lists the loaded flow", async () => {
    const res = await fetch(`${server.url}/v1/flows`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flows).toHaveLength(1);
    expect(body.flows[0]).toMatchObject({ id: "hello", nodes: 3 });
  });

  it("GET /openapi.json has a typed per-flow operation", async () => {
    const res = await fetch(`${server.url}/openapi.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v1/flows/hello/run"]?.post?.operationId).toBe("runHello");
    expect(spec.paths["/v1/flows/hello/run"]?.post?.responses?.["200"]).toBeDefined();
  });

  describe("POST /v1/flows/:id/run", () => {
    it("401 without a token", async () => {
      const res = await fetch(`${server.url}/v1/flows/hello/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
      expect(res.status).toBe(401);
    });

    it("404 for an unknown flow", async () => {
      const res = await fetch(`${server.url}/v1/flows/nope/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({}) });
      expect(res.status).toBe(404);
    });

    it("400 for a non-JSON body", async () => {
      const res = await fetch(`${server.url}/v1/flows/hello/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "not json" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/JSON/);
    });

    it("400 for a non-object input", async () => {
      const { status, body } = await runFlow(server.url, "hello", {}, TOKEN);
      // `runFlow` only accepts an object; send the wrong shape directly.
      void body;
      const res = await fetch(`${server.url}/v1/flows/hello/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ input: ["not", "an", "object"] }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/object/);
    });

    it("200 with a completed run and trace nodes", async () => {
      const { status, body } = await runFlow(server.url, "hello", { name: "API" }, TOKEN);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.runId).toBeTruthy();
      expect(body.nodes.greet).toBeDefined();
      expect(body.nodes.greet?.status).toBe("done");
      expect(body.output?.output).toBe("Hello API!");
    });

    it("SSE: emits node events then a result, in order", async () => {
      const res = await fetch(`${server.url}/v1/flows/hello/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ input: { name: "SSE" } }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("event: node:start");
      expect(text).toContain("event: node:done");
      expect(text).toContain("event: result");
      // The result event is last.
      expect(text.trim().endsWith("}")).toBe(true);
      const resultLine = [...text.split("\n")].filter((l) => l.startsWith("data: ")).at(-1)!;
      const result = JSON.parse(resultLine.slice(6));
      expect(result.ok).toBe(true);
      expect(result.output.output).toBe("Hello SSE!");
    });

    it("idempotency: a replay with the same key and input returns the stored result", async () => {
      const first = await runFlow(server.url, "hello", { name: "Idem" }, TOKEN, { "Idempotency-Key": "k1" });
      expect(first.status).toBe(200);
      expect(first.headers.get("idempotent-replayed")).toBeNull();
      const second = await runFlow(server.url, "hello", { name: "Idem" }, TOKEN, { "Idempotency-Key": "k1" });
      expect(second.status).toBe(200);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      expect(second.body.runId).toBe(first.body.runId);
    });

    it("idempotency: the same key with a different input is a 422", async () => {
      const res = await fetch(`${server.url}/v1/flows/hello/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "k2" },
        body: JSON.stringify({ input: { name: "One" } }),
      });
      expect(res.status).toBe(200);
      const res2 = await fetch(`${server.url}/v1/flows/hello/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "k2" },
        body: JSON.stringify({ input: { name: "Two" } }),
      });
      expect(res2.status).toBe(422);
    });

    it("400 for an invalid X-Milford-Timeout-Ms header", async () => {
      const res = await fetch(`${server.url}/v1/flows/hello/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "X-Milford-Timeout-Ms": "abc" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/runs", () => {
    it("lists a finished run with its trace summary", async () => {
      const { body: run } = await runFlow(server.url, "hello", { name: "Runs" }, TOKEN);
      expect(run.ok).toBe(true);
      const res = await fetch(`${server.url}/v1/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list.runs.length).toBeGreaterThanOrEqual(1);
      expect(list.runs[0].runId).toBe(run.runId);
      expect(list.runs[0].ok).toBe(true);
    });

    it("GET /v1/runs/:id returns the trace and 404 for an unknown id", async () => {
      const { body: run } = await runFlow(server.url, "hello", { name: "Trace" }, TOKEN);
      const res = await fetch(`${server.url}/v1/runs/${run.runId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      const rec = await res.json();
      expect(rec.runId).toBe(run.runId);
      expect(rec.flow).toBe("hello");

      const missing = await fetch(`${server.url}/v1/runs/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(missing.status).toBe(404);
    });
  });
});
