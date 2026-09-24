import { createEngine, defaultRegistry, type Engine, type Flow } from "@milfordai/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { serveHttp } from "../src/http.js";
import { createMcpFactory } from "../src/server.js";

let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));

const flows: Flow[] = [
  {
    id: "shout",
    description: "Upper-case the text.",
    input: { type: "object", properties: { text: { type: "string", description: "What to shout" } }, required: ["text"] },
    nodes: [{ id: "p", type: "prompt", config: { template: "{{input.text}}!" } }, { id: "out", type: "output" }],
    edges: [{ from: "p", to: "out" }],
  },
  { id: "boom", nodes: [{ id: "f", type: "fail" }], edges: [] },
  { id: "slow", nodes: [{ id: "s", type: "slow" }, { id: "out", type: "output" }], edges: [{ from: "s", to: "out" }] },
  { id: "secret", nodes: [{ id: "p", type: "prompt", config: { template: "top secret" } }, { id: "out", type: "output" }], edges: [{ from: "p", to: "out" }] },
  { id: "bad name!", nodes: [{ id: "p", type: "prompt", config: { template: "x" } }], edges: [] },
];
const registry = defaultRegistry()
  .registerNode("fail", { run: async () => ({ success: false, error: "kaboom" }) })
  .registerNode("slow", { run: async () => (await gate, { success: true, output: "done" }) });
const engine = createEngine({ registry, flows });
if (!engine.ok) throw new Error(engine.error);

const factoryFor = (target: Engine = engine.value) => {
  const result = createMcpFactory(target, { expose: ["shout", "boom", "slow"], log: () => {} });
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
/** A real MCP client wired to the handler in-process. */
const connect = async (factory = factoryFor()) => {
  const handler = createMcpHandler(factory);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init as RequestInit)) }));
  open.push(client, handler);
  return client;
};

describe("createMcpFactory", () => {
  const err = (options: object) => {
    const result = createMcpFactory(engine.value, { log: () => {}, expose: [], ...options });
    return result.ok ? "ok" : result.error;
  };
  it("exposes nothing by default and rejects unknown flows and invalid tool names", () => {
    expect(err({})).toMatch(/mcp.expose is empty/);
    expect(err({ expose: ["nope"] })).toMatch(/unknown flow "nope"/);
    expect(err({ expose: ["bad name!"] })).toMatch(/not a valid tool name/);
  });
});

describe("tools", () => {
  it("lists only the exposed flows, with the flow's description and input schema", async () => {
    const tools = (await (await connect()).listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["boom", "shout", "slow"]); // "secret" is not exposed
    const shout = tools.find((tool) => tool.name === "shout")!;
    expect(shout.description).toBe("Upper-case the text.");
    expect(shout.inputSchema).toMatchObject({ required: ["text"], properties: { text: { description: "What to shout" } } });
    expect(tools.find((tool) => tool.name === "boom")!.description).toBe('Run the "boom" flow.');
  });

  it("runs a flow and returns the typed result", async () => {
    const result = await (await connect()).callTool({ name: "shout", arguments: { text: "hi" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, output: "hi!" });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ output: "hi!" });
  });

  it("rejects arguments that break the flow's input schema without running it", async () => {
    const result = await (await connect()).callTool({ name: "shout", arguments: { text: 5 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/text/);
  });

  it("returns node errors as an error result the model can read", async () => {
    const result = await (await connect()).callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, errors: ["f: kaboom"] });
  });

  it("cannot call a flow that is not exposed", async () => {
    const result = await (await connect()).callTool({ name: "secret", arguments: {} }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
    expect(result.isError).toBe(true);
  });

  it("sheds load when too many runs are active", async () => {
    const capped = createEngine({ registry, flows, maxConcurrentRuns: 1 });
    if (!capped.ok) throw new Error(capped.error);
    const client = await connect(factoryFor(capped.value));
    const first = client.callTool({ name: "slow", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await client.callTool({ name: "slow", arguments: {} });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toMatch(/too many concurrent runs/);
    release();
    expect((await first).isError).toBeFalsy();
  });
});

describe("streamable HTTP server", () => {
  const start = async (tokens: string[]) => {
    const httpServer = serveHttp(factoryFor(), { port: 0, host: "127.0.0.1", tokens });
    open.push(httpServer);
    if (!httpServer.server.listening) await new Promise((resolve) => httpServer.server.once("listening", resolve));
    const { port } = httpServer.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  };

  it("requires the bearer token on /mcp, and serves /health without it", async () => {
    const base = await start(["s3cret"]);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });

  it("lets a client with the token list and call tools over a real socket", async () => {
    const base = await start(["s3cret"]);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer s3cret" } } }));
    open.push(client);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("shout");
    expect((await client.callTool({ name: "shout", arguments: { text: "ok" } })).structuredContent).toMatchObject({ output: "ok!" });
  });
});
