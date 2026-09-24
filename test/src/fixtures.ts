export const TOKEN = "test-token-123";

/** Extra YAML lines per config section, so a test can add keys without rebuilding the whole config. */
export type ServerConfigOptions = {
  /**
   * Replaces the default `fake` provider entry. Each entry is a full YAML list item, e.g.
   * `"- { id: backup, type: openai, ... }"`; build several with `openaiProvider`/`typesafeProvider`.
   */
  providers?: string[];
  /** Extra `run:` keys, e.g. `timeoutMs: 400` or `maxConcurrentRuns: 1`. */
  run?: string[];
  /** Extra `server:` keys. A `runs:` line here replaces the default in-memory store line. */
  server?: string[];
  /** Channel entries, e.g. `- { id: hook, type: webhook, flow: hello, secret: ... }`. */
  channels?: string[];
  /** `mcp:` keys, e.g. `expose: ["greet"]`, so `milford-mcp` can read the same config as the server. */
  mcp?: string[];
  /** The bearer token; defaults to `TOKEN`. */
  token?: string;
};

/**
 * Builds a `milford.config.yaml` for the tests. `PORT` is replaced by the harness with a free port.
 * `files` are written next to it (e.g. `flows/hello.json`). Extra YAML lines extend each section; a
 * `server.runs` line in `opts.server` replaces the default in-memory store line.
 */
export function serverConfig(fakeUrl: string, files: Record<string, object>, opts: ServerConfigOptions = {}): { config: string; files: Record<string, string> } {
  const flowLines = Object.keys(files).map((file) => `  - { file: ${file} }`);
  const providers = opts.providers ?? [`  - { id: fake, type: openai, baseUrl: "${fakeUrl}", model: fake-model }`];
  // Caller-supplied lines are indented by the builder, so tests write them flush against the margin.
  const indent = (lines: string[], extra = "  ") => lines.map((line) => extra + line);
  const serverOpts = opts.server ?? [];
  const serverLines = indent(serverOpts);
  const runs = serverOpts.some((line) => /^runs:/.test(line)) ? [] : ["  runs: { store: memory }"];
  return {
    config: [
      "providers:",
      ...providers,
      "flows:",
      ...flowLines,
      ...(opts.channels?.length ? ["channels:", ...indent(opts.channels)] : []),
      ...(opts.mcp?.length ? ["mcp:", ...indent(opts.mcp)] : []),
      ...(opts.run?.length ? ["run:", ...indent(opts.run)] : []),
      "server:",
      "  port: PORT",
      "  auth:",
      `    tokens: ["${opts.token ?? TOKEN}"]`,
      ...serverLines,
      ...runs,
    ].join("\n"),
    files: Object.fromEntries(
      Object.entries(files).map(([path, flow]) => [path, JSON.stringify(flow, null, 2)]),
    ),
  };
}

/** A `providers:` entry for an OpenAI-compatible provider on the fake. */
export const openaiProvider = (id: string, fakeUrl: string, model: string, extra = "") =>
  `  - { id: ${id}, type: openai, baseUrl: "${fakeUrl}", model: ${model}${extra ? `, ${extra}` : ""} }`;

/** A `providers:` entry for a Jev-style batch decision provider on the fake. */
export const typesafeProvider = (id: string, fakeUrl: string, model: string, extra = "") =>
  `  - { id: ${id}, type: typesafe, baseUrl: "${fakeUrl}", apiKey: fake-key, model: ${model}${extra ? `, ${extra}` : ""} }`;

export type McpConfigOptions = {
  /** Flow ids exposed as MCP tools. */
  expose: string[];
  transport: "stdio" | "http";
  /** Only for `http`. */
  host?: string;
  port?: number;
  tokens?: string[];
};

/**
 * Builds a `milford.config.yaml` for the `milford-mcp` CLI. `files` are written next to it. The flows
 * of the MCP tests call no provider, so no fake URL is needed.
 */
export function mcpConfig(files: Record<string, object>, opts: McpConfigOptions): { config: string; files: Record<string, string> } {
  const flowLines = Object.keys(files).map((file) => `  - { file: ${file} }`);
  const authLines = opts.tokens?.length ? ["  auth:", `    tokens: [${opts.tokens.map((token) => `"${token}"`).join(", ")}]`] : [];
  return {
    config: [
      "flows:",
      ...flowLines,
      "mcp:",
      `  expose: [${opts.expose.map((id) => `"${id}"`).join(", ")}]`,
      `  transport: ${opts.transport}`,
      ...(opts.transport === "http" ? [`  host: ${opts.host ?? "127.0.0.1"}`, `  port: ${opts.port ?? 8090}`] : []),
      ...authLines,
    ].join("\n"),
    files: Object.fromEntries(
      Object.entries(files).map(([path, flow]) => [path, JSON.stringify(flow, null, 2)]),
    ),
  };
}
