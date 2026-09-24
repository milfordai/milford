import type { Engine, Result } from "@milfordai/core";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

export type McpOptions = {
  /** Flow ids to expose as tools. Nothing is exposed by default. */
  expose: string[];
  /** One JSON line per tool call. Must not write to stdout when serving stdio. */
  log?: (line: string) => void;
};

// MCP tool names: letters, digits, `_`, `-`, `.`.
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * One MCP tool per exposed flow. The tool description and arguments come from the flow's `description` and
 * `input` JSON Schema. Returns a factory because HTTP serving builds a fresh server per request.
 */
export function createMcpFactory(engine: Engine, options: McpOptions): Result<() => McpServer> {
  const flows = new Map(engine.flows().map((flow) => [flow.id, flow]));
  if (!options.expose.length) return { ok: false, error: "mcp.expose is empty: list the flows to expose as tools" };
  for (const id of options.expose) {
    if (!flows.has(id)) return { ok: false, error: `mcp.expose: unknown flow "${id}"` };
    if (!TOOL_NAME.test(id)) return { ok: false, error: `mcp.expose: flow id "${id}" is not a valid tool name (use letters, digits, _ - . up to 64 characters)` };
  }
  const log = options.log ?? console.error;

  const factory = () => {
    const server = new McpServer({ name: "milford", version: "0.0.3" });
    for (const id of new Set(options.expose)) {
      const flow = flows.get(id)!;
      const inputSchema = fromJsonSchema<Record<string, unknown>>(flow.input ?? { type: "object", additionalProperties: true });
      // The type arguments cannot be inferred without an outputSchema; the second one is unused.
      server.registerTool<typeof inputSchema, typeof inputSchema>(
        id,
        { description: flow.description ?? `Run the "${id}" flow.`, inputSchema },
        async (args, ctx) => {
          const toolError = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
          const started = performance.now();
          const result = await engine.run(id, args ?? {}, { signal: ctx.mcpReq.signal });
          if (!result.ok) return toolError(result.error);

          const runResult = result.value;
          const errors = Object.entries(runResult.nodes).filter(([, nodeState]) => nodeState.status === "error").map(([nodeId, nodeState]) => `${nodeId}: ${nodeState.result?.error ?? "failed"}`);
          const out = { ok: runResult.ok, runId: runResult.runId, output: runResult.output?.output, data: runResult.output?.data, ...(errors.length && { errors }) };
          log(JSON.stringify({ level: "info", msg: "mcp tool", flow: id, ok: runResult.ok, runId: runResult.runId, ms: Math.round(performance.now() - started) }));
          return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out, isError: !runResult.ok };
        },
      );
    }
    return server;
  };
  return { ok: true, value: factory };
}
