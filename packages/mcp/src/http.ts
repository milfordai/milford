import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

const digest = (s: string) => createHash("sha256").update(s).digest();

export type HttpOptions = { port: number; host: string; tokens: string[]; log?: (line: string) => void };

/** Serves MCP over Streamable HTTP at `/mcp`, behind static bearer tokens. `/health` needs no token. */
export function serveHttp(factory: () => McpServer, o: HttpOptions) {
  const handler = createMcpHandler(factory);
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const server = serve({
    port: o.port,
    hostname: o.host,
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/health") return json({ status: "ok" }, 200);
      if (path !== "/mcp") return json({ error: "not found" }, 404);
      if (o.tokens.length) {
        const given = digest(req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "");
        // Compare against every token, without short-circuiting on the first match.
        if (!o.tokens.map((t) => timingSafeEqual(given, digest(t))).some(Boolean)) return json({ error: "unauthorized" }, 401);
      }
      return handler.fetch(req);
    },
  });
  return {
    server,
    async close() {
      await handler.close();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
