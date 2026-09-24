import { describe, expect, it } from "vitest";
import { boomFlow, greetFlow } from "../src/flows.js";
import {
  McpStdioClient,
  freeMcpPort,
  mcpHttpRpc,
  removeMcpConfig,
  runMcpOnce,
  startMcpHttp,
  writeMcpConfig,
} from "../src/mcp-client.js";
import { mcpConfig } from "../src/fixtures.js";

const flowFiles = {
  "flows/greet.json": greetFlow,
  "flows/boom.json": boomFlow,
};

describe("MIL-63: MCP entry point", () => {
  it("lists exposed tools with descriptions and input schemas over stdio", async () => {
    const setup = mcpConfig(flowFiles, { expose: ["greet", "boom"], transport: "stdio" });
    const configPath = writeMcpConfig(setup.config, setup.files);
    const client = await McpStdioClient.start(configPath);

    try {
      const result = (await client.request("tools/list")) as { tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> };
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(["boom", "greet"]);
      expect(result.tools.find((tool) => tool.name === "greet")).toMatchObject({
        description: "Greet a person by name.",
        inputSchema: { required: ["name"], properties: { name: { type: "string" } } },
      });
    } finally {
      await client.close();
      removeMcpConfig(configPath);
    }
  });

  it("returns structured success, schema errors, and flow errors over stdio", async () => {
    const setup = mcpConfig(flowFiles, { expose: ["greet", "boom"], transport: "stdio" });
    const configPath = writeMcpConfig(setup.config, setup.files);
    const client = await McpStdioClient.start(configPath);

    try {
      const success = (await client.request("tools/call", { name: "greet", arguments: { name: "MCP" } })) as {
        isError?: boolean;
        structuredContent?: { ok: boolean; output: string };
        content: Array<{ text: string }>;
      };
      expect(success.isError).toBeFalsy();
      expect(success.structuredContent).toMatchObject({ ok: true, output: "Hello MCP!" });
      expect(JSON.parse(success.content[0]!.text)).toMatchObject({ output: "Hello MCP!" });

      const invalid = (await client.request("tools/call", { name: "greet", arguments: { name: 5 } })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toMatch(/name/);

      const failed = (await client.request("tools/call", { name: "boom", arguments: {} })) as {
        isError?: boolean;
        structuredContent?: { ok: boolean; errors: string[] };
      };
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false });
      expect(failed.structuredContent?.errors[0]).toContain("boom: unknown template variable");
    } finally {
      await client.close();
      removeMcpConfig(configPath);
    }
  });

  it("authenticates MCP HTTP, lists tools, and returns structured and error results", async () => {
    const port = await freeMcpPort();
    const setup = mcpConfig(flowFiles, { expose: ["greet", "boom"], transport: "http", port, tokens: ["mcp-test-token"] });
    const configPath = writeMcpConfig(setup.config, setup.files);
    const server = await startMcpHttp(configPath, port);

    try {
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
      expect((await fetch(`${server.url}/mcp`, { method: "POST" })).status).toBe(401);

      const init = await mcpHttpRpc(server.url, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "milford-tests", version: "0.0.0" },
      }, "mcp-test-token");
      expect(init).toMatchObject({ serverInfo: { name: "milford" } });
      const tools = (await mcpHttpRpc(server.url, "tools/list", {}, "mcp-test-token")) as { tools: Array<{ name: string }> };
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["greet", "boom"]));

      const success = (await mcpHttpRpc(server.url, "tools/call", { name: "greet", arguments: { name: "HTTP" } }, "mcp-test-token")) as {
        structuredContent?: { output: string };
      };
      expect(success.structuredContent).toMatchObject({ output: "Hello HTTP!" });

      const failed = (await mcpHttpRpc(server.url, "tools/call", { name: "boom", arguments: {} }, "mcp-test-token")) as {
        isError?: boolean;
        structuredContent?: { errors: string[] };
      };
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ errors: [expect.stringContaining("boom: unknown template variable")] });
    } finally {
      await server.close();
      removeMcpConfig(configPath);
    }
  });

  it("allows unauthenticated HTTP MCP only on loopback", async () => {
    const port = await freeMcpPort();
    const setup = mcpConfig(flowFiles, { expose: ["greet"], transport: "http", host: "127.0.0.1", port });
    const configPath = writeMcpConfig(setup.config, setup.files);
    const server = await startMcpHttp(configPath, port);

    try {
      const tools = (await mcpHttpRpc(server.url, "tools/list")) as { tools: Array<{ name: string }> };
      expect(tools.tools.map((tool) => tool.name)).toContain("greet");
    } finally {
      await server.close();
      removeMcpConfig(configPath);
    }

    const publicSetup = mcpConfig(flowFiles, { expose: ["greet"], transport: "http", host: "0.0.0.0", port: await freeMcpPort() });
    const publicPath = writeMcpConfig(publicSetup.config, publicSetup.files);
    try {
      const result = await runMcpOnce(publicPath);
      expect(result.code).toBe(1);
      expect(result.err).toContain("mcp.auth.tokens is required");
    } finally {
      removeMcpConfig(publicPath);
    }
  });
});
