import { createEngine, defaultRegistry, flow, type Flow } from "@milford/core";
import { afterEach, describe, expect, it } from "vitest";
import { registerMcp } from "./egress.js";
import { serveHttp } from "./http.js";
import { createMcpFactory } from "./server.js";

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
  const f = createMcpFactory(engine.value, { expose: ["shout", "decide", "boom"], log: () => {} });
  if (!f.ok) throw new Error(f.error);
  const http = serveHttp(f.value, { port: 0, host: "127.0.0.1", tokens: ["tok"] });
  open.push(http);
  if (!http.server.listening) await new Promise((r) => http.server.once("listening", r));
  return `http://127.0.0.1:${(http.server.address() as { port: number }).port}/mcp`;
};

/** The calling engine: registers the `mcp` node against the remote server. */
const caller = (url: string, flows: Flow[], token = "tok") => {
  const registry = defaultRegistry();
  const egress = registerMcp(registry, [{ id: "crm", url, headers: { authorization: `Bearer ${token}` } }]);
  open.push(egress);
  return createEngine({ registry, flows });
};
const call = (config: object) => flow("f").node("in", "input").node("m", "mcp", { server: "crm", ...config }).node("out", "output").edge("in", "m").edge("m", "out").build();
const run = async (e: ReturnType<typeof caller>, input: Record<string, unknown> = {}) => {
  if (!e.ok) throw new Error(e.error);
  const r = await e.value.run("f", input);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("mcp node", () => {
  it("calls a tool on another MCP server with templated arguments", async () => {
    const r = await run(caller(await remote(), [call({ tool: "shout", arguments: { text: "{{input.word}}" } })]), { word: "hey" });
    expect(r.ok).toBe(true);
    expect(r.nodes.m?.result?.data).toMatchObject({ ok: true, output: "hey!" }); // the remote's structured result
  });

  it("returns plain text as output when the result is not JSON", async () => {
    const r = await run(caller(await remote(), [call({ tool: "decide" })]));
    expect(r.nodes.m?.result?.data).toMatchObject({ output: "plain text, not json" });
  });

  it("fails the node when the tool reports an error", async () => {
    const r = await run(caller(await remote(), [call({ tool: "boom" })]));
    expect(r.ok).toBe(false);
    expect(r.nodes.m?.result?.error).toContain("kaboom");
  });

  it("fails the node when the server rejects the token", async () => {
    const r = await run(caller(await remote(), [call({ tool: "shout", arguments: { text: "x" } })], "wrong"));
    expect(r.ok).toBe(false);
  });

  it("lets a decision pick the tool, restricted to an allow list", async () => {
    const dynamic = flow("f")
      .node("pick", "prompt", { template: "{{input.tool}}" })
      .node("m", "mcp", { server: "crm", tool: "{{pick}}", arguments: { text: "z" }, allow: ["shout", "decide"] })
      .node("out", "output")
      .edge("pick", "m").edge("m", "out").build();
    const url = await remote();
    expect((await run(caller(url, [dynamic]), { tool: "shout" })).nodes.m?.result?.data).toMatchObject({ output: "z!" });
    const blocked = await run(caller(url, [dynamic]), { tool: "boom" });
    expect(blocked.nodes.m?.result?.error).toBe('tool "boom" is not in the allow list');
  });

  it("rejects bad config when the flow loads", async () => {
    const url = await remote();
    expect(caller(url, [call({ tool: "{{input.t}}" })])).toMatchObject({ ok: false, error: expect.stringContaining("allow list") });
    expect(caller(url, [call({ server: "nope", tool: "shout" })])).toMatchObject({ ok: false, error: expect.stringContaining("unknown MCP server") });
  });

  it("fails cleanly, without throwing, after the remote goes away", async () => {
    const url = await remote();
    const e = caller(url, [call({ tool: "shout", arguments: { text: "a" } })]);
    expect((await run(e)).ok).toBe(true);
    await open.shift()!.close(); // stop the remote
    expect((await run(e)).ok).toBe(false);
  });
});
