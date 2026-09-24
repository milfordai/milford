import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer. `match` is a substring of the last user message; omitted matches any request. */
export type Rule =
  | { match?: string; latencyMs?: number; type: "chat"; result: { text: string } }
  | { match?: string; latencyMs?: number; type: "chat-error"; status: number; body?: string }
  | { match?: string; latencyMs?: number; type: "decide"; result: unknown };

/**
 * A deterministic OpenAI-compatible `/v1/chat/completions` server. `llm`/`decision` nodes and `openai`
 * providers talk to it; everything runs offline. Rules match on the request, so a test can script a
 * retry (first call fails, second answers) and exact answers per prompt.
 */
export class FakeProvider {
  private server!: Server;
  url = "";
  private rules: Rule[] = [];
  /** Every request as raw text, for assertions. */
  requests: string[] = [];

  async start(rules: Rule[] = []) {
    this.rules = [...rules];
    this.server = createServer((req, res) => {
      let text = "";
      req.on("data", (d) => text += d);
      req.on("end", () => {
        this.requests.push(text);
        const json = JSON.parse(text || "{}") as { messages?: { role: string; content: string }[] };
        if (req.url?.includes("/chat/completions") !== true) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        const tail = [...(json.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
        // A rule with `match` is consumed (for retry scripting); a default rule (no `match`) stays,
        // so an echo rule can answer every request.
        const idx = this.rules.findIndex((r) => r.match !== undefined && tail.includes(r.match));
        const matched = idx >= 0 ? this.rules.splice(idx, 1)[0] : undefined;
        const rule = matched ?? this.rules.find((r) => r.match === undefined);
        if (!rule) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no scripted answer left" }));
          return;
        }
        const done = () => {
          if (rule.type === "chat-error") {
            res.writeHead(rule.status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: rule.body ?? "provider error" }));
            return;
          }
          // `{{prompt}}` in a scripted text is replaced with the last user message, so one rule can
          // echo deterministically regardless of how many requests arrive.
          const text = rule.type === "chat" ? rule.result.text.replace(/\{\{prompt\}\}/g, tail) : JSON.stringify(rule.result);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "fake-model",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        };
        if (rule.latencyMs) setTimeout(done, rule.latencyMs); else done();
      });
    });
    await new Promise<void>((res) => this.server.listen(0, "127.0.0.1", res));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    await new Promise<void>((res, rej) => this.server.close((e) => (e ? rej(e) : res())));
  }

  /** Count of requests whose body contains the given text. */
  count(text: string): number {
    return this.requests.filter((r) => r.includes(text)).length;
  }
}
