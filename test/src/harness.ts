import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The suite tests a running Milford as a black box. The default target is the built CLI of the local
 * checkout (`../milford/packages/server/dist/cli.js`, run with `node`), so tests exercise the real
 * assembled artifact. A `MILFORD_SERVER` path or a `MILFORD_TARGET=http://...` URL overrides it.
 */
export type Target = { kind: "cli"; cmd: string[] } | { kind: "url"; url: string };

export function resolveTarget(): Target {
  const url = process.env.MILFORD_TARGET;
  if (url && /^https?:\/\//.test(url)) return { kind: "url", url };
  const cli = process.env.MILFORD_SERVER ?? resolve(import.meta.dirname, "../../packages/server/dist/cli.js");
  return { kind: "cli", cmd: [process.execPath, cli] };
}

export type ServerOptions = {
  /** Config file contents. `PORT` is replaced with the test's free port. */
  config: string;
  /** Extra files written into the same temp dir, keyed by path. Flow files belong here. */
  files?: Record<string, string>;
  /** How long to wait for the server to report ready. */
  readyTimeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Reuse this directory instead of a fresh temp dir, so a second start can see the first one's data
   * (restart tests). The caller owns it: `close` does not delete it, and the config is rewritten with
   * the new port on every start.
   */
  dir?: string;
};

export class RunningServer {
  readonly url: string;
  readonly env: Record<string, string>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logsBuffer: string[];
  private readonly exited: Promise<{ code: number | null; logs: string }>;
  private readonly dir: string;
  /** False when the caller supplied `dir` and keeps it after `close`. */
  private readonly ownsDir: boolean;
  private stopped = false;

  private constructor(
    url: string,
    child: ChildProcessWithoutNullStreams,
    logsBuffer: string[],
    exited: Promise<{ code: number | null; logs: string }>,
    env: Record<string, string>,
    dir: string,
    ownsDir: boolean,
  ) {
    this.url = url;
    this.child = child;
    this.logsBuffer = logsBuffer;
    this.exited = exited;
    this.env = env;
    this.dir = dir;
    this.ownsDir = ownsDir;
  }

  static async start(opts: ServerOptions): Promise<RunningServer> {
    const target = resolveTarget();
    if (target.kind === "url") {
      const base = target.url.replace(/\/$/, "");
      await waitForHealth(base, opts.readyTimeoutMs ?? 20_000);
      return new RunningServer(base, undefined as never, [], Promise.resolve({ code: null, logs: "" }), opts.env ?? {}, "", false);
    }
    const port = await freePort();
    const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "milford-test-"));
    const cfgPath = join(dir, "milford.config.yaml");
    writeFileSync(cfgPath, opts.config.replace("PORT", String(port)));
    for (const [p, content] of Object.entries(opts.files ?? {})) {
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const logsBuffer: string[] = [];
    const child = spawn(target.cmd[0]!, target.cmd.slice(1), {
      cwd: dir,
      env: { ...process.env, ...(opts.env ?? {}), MILFORD_CONFIG: cfgPath },
    }) as ChildProcessWithoutNullStreams;
    const exited = new Promise<{ code: number | null; logs: string }>((res) => {
      child.stdout.on("data", (d) => logsBuffer.push(d.toString()));
      child.stderr.on("data", (d) => logsBuffer.push(d.toString()));
      child.on("exit", (code) => res({ code, logs: logsBuffer.join("") }));
    });
    const server = new RunningServer(`http://127.0.0.1:${port}`, child, logsBuffer, exited, opts.env ?? {}, dir, opts.dir === undefined);
    try {
      await waitForHealth(server.url, opts.readyTimeoutMs ?? 20_000, exited, logsBuffer);
    } catch (e) {
      await server.close();
      throw e;
    }
    return server;
  }

  /** Everything the server wrote to stdout or stderr so far. */
  logs(): string {
    return this.logsBuffer.join("");
  }

  /**
   * SIGTERM, let it drain (the CLI exits itself within 10s), then SIGKILL as a backstop. `timeoutMs`
   * raises the backstop, so a test can watch the CLI's own slower shutdown path take effect first.
   */
  async close(timeoutMs = 10_000): Promise<{ code: number | null; logs: string }> {
    if (this.stopped) return this.exited;
    this.stopped = true;
    if (this.child.pid !== undefined && this.child.exitCode === null) this.child.kill("SIGTERM");
    const raced = await Promise.race([this.exited, new Promise<null>((res) => setTimeout(() => res(null), timeoutMs))]);
    if (raced === null && this.child.exitCode === null) this.child.kill("SIGKILL");
    if (this.ownsDir) rmSync(this.dir, { recursive: true, force: true });
    return raced ?? { code: this.child.exitCode, logs: this.logs() };
  }
}

/** Runs the suite's default target. Prefer `RunningServer.start`. */
export const startServer = (opts: ServerOptions): Promise<RunningServer> => RunningServer.start(opts);

/** A free TCP port on 127.0.0.1, for servers the harness does not start itself (the MCP HTTP server). */
export async function freePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  exited?: Promise<{ code: number | null; logs: string }>,
  logs?: string[],
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited && (await Promise.race([exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 100))]))) {
      const e = await exited;
      throw new Error(`milford exited before becoming ready (exit ${e.code}):\n${e.logs}`);
    }
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  const tail = logs?.join("").slice(-500) ?? "";
  throw new Error(`server did not become ready on ${url} within ${timeoutMs}ms${tail ? `:\n${tail}` : ""}`);
}

/**
 * Runs `milford-server <command...> [config]` against the given config and returns the exit code and
 * output. `command` is one word (`validate`, `openapi`, `runs`) or several (`["runs", "show", id]`);
 * the config path is always appended last.
 */
export async function runCli(
  command: string | string[],
  configText: string,
  opts: { env?: Record<string, string>; files?: Record<string, string> } = {},
): Promise<{ code: number | null; out: string }> {
  const target = resolveTarget();
  if (target.kind !== "cli") throw new Error("runCli only supports the local CLI target");
  const dir = mkdtempSync(join(tmpdir(), "milford-test-cli-"));
  const cfgPath = join(dir, "milford.config.yaml");
  writeFileSync(cfgPath, configText.replace("PORT", "0"));
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const out: string[] = [];
  const words = Array.isArray(command) ? command : [command];
  const code = await new Promise<number | null>((res) => {
    const child = spawn(target.cmd[0]!, [...target.cmd.slice(1), ...words, cfgPath], {
      cwd: dir,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("exit", (c) => res(c));
  });
  rmSync(dir, { recursive: true, force: true });
  return { code, out: out.join("") };
}
