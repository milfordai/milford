import { render, renderDeep, scopeOf, type NodeDef, type Registry } from "@milford/core";
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
  const byId = new Map(servers.map((s) => [s.id, s]));
  const clients = new Map<string, Promise<Client>>();

  const connect = (s: McpServerConfig): Promise<Client> => {
    let p = clients.get(s.id);
    if (!p) {
      p = (async () => {
        const c = new Client({ name: "milford", version: "0.0.1" });
        await c.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers ?? {} } }));
        return c;
      })();
      clients.set(s.id, p);
    }
    return p;
  };
  /** Forget a connection after an error so the next call reconnects. */
  const drop = (id: string) => {
    const p = clients.get(id);
    clients.delete(id);
    void p?.then((c) => c.close()).catch(() => {});
  };

  const config = z
    .object({
      server: z.string().refine((id) => byId.has(id), { message: "unknown MCP server (declare it under mcpServers)" }),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
      /** Tools this node may call. Required when `tool` is a template. */
      allow: z.array(z.string()).optional(),
    })
    .refine((c) => !c.tool.includes("{{") || c.allow?.length, { message: "a templated tool needs an allow list of tool names", path: ["allow"] });

  const node: NodeDef<z.infer<typeof config>> = {
    configSchema: config,
    async run(ctx, up) {
      const scope = scopeOf(ctx.input, up);
      const tool = render(ctx.config.tool, scope);
      if (!tool.ok) return fail(tool.error);
      if (ctx.config.allow && !ctx.config.allow.includes(tool.value)) return fail(`tool "${tool.value}" is not in the allow list`);
      const args = renderDeep(ctx.config.arguments, scope);
      if (!args.ok) return fail(args.error);

      const server = byId.get(ctx.config.server)!;
      try {
        const client = await connect(server);
        const r = await client.callTool({ name: tool.value, arguments: args.value as Record<string, unknown> }, { signal: ctx.signal });
        const text = ((r.content ?? []) as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join("\n");
        if (r.isError) return fail(text || `tool "${tool.value}" failed`);
        let data: unknown = r.structuredContent;
        if (data === undefined) {
          try {
            data = JSON.parse(text);
          } catch {
            /* plain text result */
          }
        }
        return { success: true, output: text, data };
      } catch (e) {
        drop(server.id);
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };
  registry.registerNode("mcp", node);
  return { close: async () => void (await Promise.all([...clients.keys()].map((id) => clients.get(id)!.then((c) => c.close()).catch(() => {})))) };
}
