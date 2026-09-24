import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

const digest = (value: string) => createHash("sha256").update(value).digest();

export type HttpOptions = { port: number; host: string; tokens: string[]; log?: (line: string) => void };

/** Serves MCP over Streamable HTTP at `/mcp`, behind static bearer tokens. `/health` needs no token. */
export function serveHttp(factory: () => McpServer, options: HttpOptions) {
  const handler = createMcpHandler(factory);
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const server = serve({
    port: options.port,
    hostname: options.host,
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/health") return json({ status: "ok" }, 200);
      if (path !== "/mcp") return json({ error: "not found" }, 404);
      if (options.tokens.length) {
        const given = digest(request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "");
        // Compare against every token, without short-circuiting on the first match.
        if (!options.tokens.map((token) => timingSafeEqual(given, digest(token))).some(Boolean)) return json({ error: "unauthorized" }, 401);
      }
      return handler.fetch(request);
    },
  });
  return {
    server,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
