import { createEngine, defaultRegistry, flow, type Flow } from "@milfordai/core";
import { afterEach, describe, expect, it } from "vitest";
import { registerMcp } from "../src/egress.js";
import { serveHttp } from "../src/http.js";
import { createMcpFactory } from "../src/server.js";

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The remote MCP server: a Milford engine that exposes a few flows as tools, behind a bearer token. */
const remote = async () => {
  const flows: Flow[] = [
    { id: "shout", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, nodes: [{ id: "p", type: "prompt", config: { template: "{{input.text}}!" } }, { id: "out", type: "output" }], edges: [{ from: "p", to: "out" }] },
    { id: "decide", nodes: [{ id: "f", type: "prompt", config: { template: "plain text, not json" } }, { id: "out", type: "output" }], edges: [{ from: "f", to: "out" }] },
    { id: "boom", nodes: [{ id: "f", type: "fail" }], edges: [] },
  ];
  const engine = createEngine({ registry: defaultRegistry().registerNode("fail", { run: async () => ({ success: false, error: "kaboom" }) }), flows });
  if (!engine.ok) throw new Error(engine.error);
  const factory = createMcpFactory(engine.value, { expose: ["shout", "decide", "boom"], log: () => {} });
  if (!factory.ok) throw new Error(factory.error);
  const httpServer = serveHttp(factory.value, { port: 0, host: "127.0.0.1", tokens: ["tok"] });
  open.push(httpServer);
  if (!httpServer.server.listening) await new Promise((resolve) => httpServer.server.once("listening", resolve));
  return `http://127.0.0.1:${(httpServer.server.address() as { port: number }).port}/mcp`;
};

/** The calling engine: registers the `mcp` node against the remote server. */
const caller = (url: string, flows: Flow[], token = "tok") => {
  const registry = defaultRegistry();
  const egress = registerMcp(registry, [{ id: "crm", url, headers: { authorization: `Bearer ${token}` } }]);
  open.push(egress);
  return createEngine({ registry, flows });
};
const call = (config: object) => flow("f").node("in", "input").node("m", "mcp", { server: "crm", ...config }).node("out", "output").edge("in", "m").edge("m", "out").build();
const run = async (engine: ReturnType<typeof caller>, input: Record<string, unknown> = {}) => {
  if (!engine.ok) throw new Error(engine.error);
  const result = await engine.value.run("f", input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("mcp node", () => {
  it("calls a tool on another MCP server with templated arguments", async () => {
    const result = await run(caller(await remote(), [call({ tool: "shout", arguments: { text: "{{input.word}}" } })]), { word: "hey" });
    expect(result.ok).toBe(true);
    expect(result.nodes.m?.result?.data).toMatchObject({ ok: true, output: "hey!" }); // the remote's structured result
  });

  it("returns plain text as output when the result is not JSON", async () => {
    const result = await run(caller(await remote(), [call({ tool: "decide" })]));
    expect(result.nodes.m?.result?.data).toMatchObject({ output: "plain text, not json" });
  });

  it("fails the node when the tool reports an error", async () => {
    const result = await run(caller(await remote(), [call({ tool: "boom" })]));
    expect(result.ok).toBe(false);
    expect(result.nodes.m?.result?.error).toContain("kaboom");
  });

  it("fails the node when the server rejects the token", async () => {
    const result = await run(caller(await remote(), [call({ tool: "shout", arguments: { text: "x" } })], "wrong"));
    expect(result.ok).toBe(false);
  });

  it("lets a decision pick the tool, restricted to an allow list", async () => {
    const dynamicFlow = flow("f")
      .node("pick", "prompt", { template: "{{input.tool}}" })
      .node("m", "mcp", { server: "crm", tool: "{{pick}}", arguments: { text: "z" }, allow: ["shout", "decide"] })
      .node("out", "output")
      .edge("pick", "m").edge("m", "out").build();
    const url = await remote();
    expect((await run(caller(url, [dynamicFlow]), { tool: "shout" })).nodes.m?.result?.data).toMatchObject({ output: "z!" });
    const blocked = await run(caller(url, [dynamicFlow]), { tool: "boom" });
    expect(blocked.nodes.m?.result?.error).toBe('tool "boom" is not in the allow list');
  });

  it("rejects bad config when the flow loads", async () => {
    const url = await remote();
    expect(caller(url, [call({ tool: "{{input.t}}" })])).toMatchObject({ ok: false, error: expect.stringContaining("allow list") });
    expect(caller(url, [call({ server: "nope", tool: "shout" })])).toMatchObject({ ok: false, error: expect.stringContaining("unknown MCP server") });
  });

  it("fails cleanly, without throwing, after the remote goes away", async () => {
    const url = await remote();
    const engine = caller(url, [call({ tool: "shout", arguments: { text: "a" } })]);
    expect((await run(engine)).ok).toBe(true);
    await open.shift()!.close(); // stop the remote
    expect((await run(engine)).ok).toBe(false);
  });
});
