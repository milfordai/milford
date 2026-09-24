import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

const digest = (value: string) => createHash("sha256").update(value).digest();

export type HttpOptions = { port: number; host: string; tokens: string[]; /** Largest accepted request body. Defaults to 1 MB. */ maxBodyBytes?: number; log?: (line: string) => void };

/** Serves MCP over Streamable HTTP at `/mcp`, behind static bearer tokens. `/health` needs no token. */
export function serveHttp(factory: () => McpServer, options: HttpOptions) {
  if (options.tokens.some((token) => token.trim() === "")) {
    throw new Error("tokens must not be empty or whitespace: an empty token would authenticate requests that send no credentials");
  }

  const handler = createMcpHandler(factory);
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
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
      // Like the REST server's body limit: without it a caller can buffer an unbounded JSON body in memory.
      const declaredBytes = Number(request.headers.get("content-length") ?? "0");
      if (declaredBytes > maxBodyBytes) return json({ error: "body too large" }, 413);
      if (request.method !== "GET" && request.method !== "HEAD") {
        const text = await request.text();
        if (text.length > maxBodyBytes) return json({ error: "body too large" }, 413);
        request = new Request(request, { body: text, signal: request.signal });
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
