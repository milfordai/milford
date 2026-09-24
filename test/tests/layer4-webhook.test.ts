import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider } from "../src/fake-provider.js";
import { helloFlow } from "../src/flows.js";
import { serverConfig, TOKEN } from "../src/fixtures.js";
import { startServer, type RunningServer } from "../src/harness.js";
import { postWebhook, signWebhook } from "../src/webhook.js";

const SECRET = "webhook-test-secret";
let fake: FakeProvider;
let server: RunningServer;

beforeAll(async () => {
  fake = await new FakeProvider().start();
  const { config, files } = serverConfig(fake.url, { "flows/hello.json": helloFlow }, {
    channels: [`- { id: hook, type: webhook, flow: hello, secret: ${SECRET} }`],
    server: ["maxBodyBytes: 128"],
  });
  server = await startServer({ config, files });
});

afterAll(async () => {
  await server.close();
  await fake.stop();
});

describe("MIL-63: webhook channel", () => {
  it("accepts a correctly signed object without the API bearer token", async () => {
    const response = await postWebhook(`${server.url}/hooks/hook`, SECRET, JSON.stringify({ name: "Webhook" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, output: "Hello Webhook!" });
  });

  it("rejects a bad signature and a signature made with the wrong secret", async () => {
    const body = JSON.stringify({ name: "Webhook" });
    const headers = signWebhook(SECRET, Math.floor(Date.now() / 1000), body);
    headers["x-milford-signature"] = "sha256=00";
    const bad = await fetch(`${server.url}/hooks/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(bad.status).toBe(401);

    const wrong = await postWebhook(`${server.url}/hooks/hook`, "different-webhook-secret", body);
    expect(wrong.status).toBe(401);
  });

  it("accepts the five-minute boundary and rejects stale or future timestamps", async () => {
    const body = JSON.stringify({ name: "Boundary" });
    const now = Math.floor(Date.now() / 1000);
    expect((await postWebhook(`${server.url}/hooks/hook`, SECRET, body, now - 299)).status).toBe(200);
    expect((await postWebhook(`${server.url}/hooks/hook`, SECRET, body, now - 301)).status).toBe(401);
    expect((await postWebhook(`${server.url}/hooks/hook`, SECRET, body, now + 301)).status).toBe(401);
  });

  it("allows a valid delivery to be retried while its signed timestamp is fresh", async () => {
    const body = JSON.stringify({ name: "Replay" });
    const first = await postWebhook(`${server.url}/hooks/hook`, SECRET, body);
    const replay = await postWebhook(`${server.url}/hooks/hook`, SECRET, body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { runId: string }).toMatchObject({ ok: true });
  });

  it("rejects non-object and malformed JSON bodies", async () => {
    for (const body of ["[1, 2]", "{"]) {
      const response = await postWebhook(`${server.url}/hooks/hook`, SECRET, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/JSON object|JSON/);
    }
  });

  it("enforces the configured webhook body limit", async () => {
    const body = JSON.stringify({ name: "x".repeat(300) });
    const response = await postWebhook(`${server.url}/hooks/hook`, SECRET, body);

    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("body too large");
  });

  it("returns 404 for an unknown webhook", async () => {
    const response = await fetch(`${server.url}/hooks/no-such-hook`, { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown webhook");
  });
});
