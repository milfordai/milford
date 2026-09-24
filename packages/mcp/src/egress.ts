import { render, renderDeep, scopeOf, type NodeDef, type Registry } from "@milfordai/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

export type McpServerConfig = { id: string; url: string; headers?: Record<string, string> };

const fail = (error: string) => ({ success: false as const, error });

/**
 * Registers the `mcp` node: call one tool on a configured MCP server (Streamable HTTP). The tool name can be a
 * template, for example `{{router}}`, so a decision can pick it, but then `allow` must list the permitted tools.
 * Returns `close` to shut the connections down.
 */
export function registerMcp(registry: Registry, servers: McpServerConfig[]): { close(): Promise<void> } {
  const byId = new Map(servers.map((server) => [server.id, server]));
  const clients = new Map<string, Promise<Client>>();

  const connect = (server: McpServerConfig): Promise<Client> => {
    let pending = clients.get(server.id);
    if (!pending) {
      pending = (async () => {
        const client = new Client({ name: "milford", version: "0.0.3" });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
        return client;
      })();
      clients.set(server.id, pending);
    }
    return pending;
  };
  /** Forget a connection after an error so the next call reconnects. */
  const drop = (id: string) => {
    const pending = clients.get(id);
    clients.delete(id);
    void pending?.then((client) => client.close()).catch(() => {});
  };

  const config = z
    .object({
      server: z.string().refine((id) => byId.has(id), { message: "unknown MCP server (declare it under mcpServers)" }),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
      /** Tools this node may call. Required when `tool` is a template. */
      allow: z.array(z.string()).optional(),
    })
    .refine((parsed) => !parsed.tool.includes("{{") || parsed.allow?.length, { message: "a templated tool needs an allow list of tool names", path: ["allow"] });

  const node: NodeDef<z.infer<typeof config>> = {
    configSchema: config,
    async run(ctx, upstream) {
      const scope = scopeOf(ctx.input, upstream);
      const renderedTool = render(ctx.config.tool, scope);
      if (!renderedTool.ok) return fail(renderedTool.error);
      if (ctx.config.allow && !ctx.config.allow.includes(renderedTool.value)) return fail(`tool "${renderedTool.value}" is not in the allow list`);

      const renderedArgs = renderDeep(ctx.config.arguments, scope);
      if (!renderedArgs.ok) return fail(renderedArgs.error);

      const server = byId.get(ctx.config.server)!;
      try {
        const client = await connect(server);
        const result = await client.callTool({ name: renderedTool.value, arguments: renderedArgs.value as Record<string, unknown> }, { signal: ctx.signal });
        const text = ((result.content ?? []) as { type: string; text?: string }[]).flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
        if (result.isError) return fail(text || `tool "${renderedTool.value}" failed`);

        let data: unknown = result.structuredContent;
        if (data === undefined) {
          try {
            data = JSON.parse(text);
          } catch {
            /* plain text result */
          }
        }
        return { success: true, output: text, data };
      } catch (error) {
        drop(server.id);
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
  registry.registerNode("mcp", node);
  return { close: async () => void (await Promise.all([...clients.keys()].map((id) => clients.get(id)!.then((client) => client.close()).catch(() => {})))) };
}
