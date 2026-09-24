import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The `milford-mcp` CLI of the local checkout (`MILFORD_MCP` overrides it, like `MILFORD_SERVER`). */
export function mcpCliPath(): string {
  return process.env.MILFORD_MCP ?? resolve(import.meta.dirname, "../../packages/mcp/dist/cli.js");
}

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; result?: unknown; error?: unknown };

/** Writes a config and its files into a fresh temp dir, and returns the config path. */
export function writeMcpConfig(config: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "milford-test-mcp-"));
  const cfgPath = join(dir, "milford.config.yaml");
  writeFileSync(cfgPath, config);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return cfgPath;
}

const removeConfig = (cfgPath: string) => rmSync(dirname(cfgPath), { recursive: true, force: true });

/**
 * A minimal MCP client over stdio: newline-delimited JSON-RPC 2.0 on the child's stdin/stdout. Server
 * notifications and requests are ignored; responses are matched by id. Milford's human-readable logs
 * go to stderr, so stdout stays pure protocol.
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly errBuffer: string[] = [];
  private readonly exited: Promise<{ code: number | null; err: string }>;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    let buffer = "";
    this.exited = new Promise((res) => {
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // an incomplete line stays until the next chunk
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this.receive(JSON.parse(trimmed) as JsonRpcMessage);
          } catch { /* not a JSON line; the protocol line is ignored */ }
        }
      });
      child.stderr.on("data", (d) => this.errBuffer.push(d.toString()));
      child.on("exit", (code) => {
        for (const entry of this.pending.values()) entry.reject(new Error(`milford-mcp exited (code ${code})`));
        res({ code, err: this.errBuffer.join("") });
      });
    });
  }

  /** Spawns `milford-mcp <config>`; the caller gets a connected client after `initialize`. */
  static async start(cfgPath: string, env: Record<string, string> = {}): Promise<McpStdioClient> {
    const child = spawn(process.execPath, [mcpCliPath(), cfgPath], { env: { ...process.env, ...env }, cwd: dirname(cfgPath) }) as ChildProcessWithoutNullStreams;
    const client = new McpStdioClient(child);
    try {
      await client.initialize();
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }

  /** The MCP handshake: `initialize`, then `notifications/initialized`. */
  async initialize(): Promise<{ protocolVersion: string; serverInfo: { name: string } }> {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "milford-tests", version: "0.0.0" },
    })) as { protocolVersion: string; serverInfo: { name: string } };
    this.notify("notifications/initialized");
    return result;
  }

  /** Sends one request and resolves its response. */
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Sends one notification (no response). */
  notify(method: string, params: Record<string, unknown> = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Everything milford-mcp wrote to stderr so far. */
  logs(): string {
    return this.errBuffer.join("");
  }

  /** Stops the client and waits for the process to exit (it exits on SIGTERM within 10s). */
  async close(): Promise<{ code: number | null; err: string }> {
    if (this.closed) return this.exited;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    const raced = await Promise.race([this.exited, new Promise<null>((res) => setTimeout(() => res(null), 10_000))]);
    if (raced === null && this.child.exitCode === null) this.child.kill("SIGKILL");
    return raced ?? { code: this.child.exitCode, err: this.logs() };
  }

  private receive(message: JsonRpcMessage) {
    if (message.id === undefined || !this.pending.has(message.id as number)) return; // a notification or server request
    const entry = this.pending.get(message.id as number)!;
    this.pending.delete(message.id as number);
    if (message.error !== undefined) entry.reject(new Error(`JSON-RPC error on "${message.method ?? "response"}": ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
  }
}

/** A spawned `milford-mcp` serving HTTP, waited until its `/health` answers. */
export type McpHttpServer = {
  /** Base URL (`http://127.0.0.1:<port>`); MCP requests go to `<url>/mcp`. */
  url: string;
  close(): Promise<{ code: number | null; err: string }>;
};

export async function startMcpHttp(cfgPath: string, port: number, env: Record<string, string> = {}): Promise<McpHttpServer> {
  const child = spawn(process.execPath, [mcpCliPath(), cfgPath], { env: { ...process.env, ...env }, cwd: dirname(cfgPath) }) as ChildProcessWithoutNullStreams;
  const errBuffer: string[] = [];
  const exited = new Promise<{ code: number | null; err: string }>((res) => {
    child.stderr.on("data", (d) => errBuffer.push(d.toString()));
    child.on("exit", (code) => res({ code, err: errBuffer.join("") }));
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitUntilHttp(`${url}/health`, 20_000, exited);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
  return {
    url,
    async close() {
      if (child.exitCode === null) child.kill("SIGTERM");
      const raced = await Promise.race([exited, new Promise<null>((res) => setTimeout(() => res(null), 10_000))]);
      if (raced === null && child.exitCode === null) child.kill("SIGKILL");
      return raced ?? { code: child.exitCode, err: errBuffer.join("") };
    },
  };
}

/** Runs `milford-mcp <config>` once to completion; for configs that exit immediately. */
export async function runMcpOnce(cfgPath: string, env: Record<string, string> = {}): Promise<{ code: number | null; err: string }> {
  const child = spawn(process.execPath, [mcpCliPath(), cfgPath], { env: { ...process.env, ...env }, cwd: dirname(cfgPath) }) as ChildProcessWithoutNullStreams;
  const errBuffer: string[] = [];
  const code = await new Promise<number | null>((res) => {
    child.stderr.on("data", (d) => errBuffer.push(d.toString()));
    child.on("exit", (c) => res(c));
  });
  return { code, err: errBuffer.join("") };
}

/** One MCP request over Streamable HTTP: a POST answered by JSON or a single SSE message. */
export async function mcpHttpRpc(url: string, method: string, params: Record<string, unknown> = {}, token?: string, id = 1): Promise<unknown> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    // The response frame(s) are `event: message` + `data: <json>`; keep-alive comments are ignored.
    const datas = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as JsonRpcMessage);
    const answer = datas.find((message) => message.id === id);
    if (answer?.error !== undefined) throw new Error(`JSON-RPC error on "${method}": ${JSON.stringify(answer.error)}`);
    return answer?.result;
  }
  const message = JSON.parse(text || "{}") as JsonRpcMessage;
  if (message.error !== undefined) throw new Error(`JSON-RPC error on "${method}": ${JSON.stringify(message.error)}`);
  return message.result;
}

async function waitUntilHttp(url: string, timeoutMs: number, exited?: Promise<{ code: number | null; err: string }>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      const died = await Promise.race([exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 100))]);
      if (died) throw new Error(`milford-mcp exited before listening:\n${(await exited).err}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`milford-mcp did not listen on ${url} within ${timeoutMs}ms`);
}

/** A free TCP port on 127.0.0.1, for the MCP HTTP server. */
export async function freeMcpPort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => res(port));
    });
    server.on("error", rej);
  });
}

export { removeConfig as removeMcpConfig };
