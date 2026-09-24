import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One scripted answer. `match` is a substring of the request's prompt text; a rule with `match` is
 * consumed by the first request that uses it, so a test can script a retry. `model` scopes a rule to
 * requests for that model, and `path` to that URL path substring, so several providers can share one
 * fake with different answers.
 */
export type Rule =
  | { match?: string; model?: string; path?: string; latencyMs?: number; type: "chat"; result: { text: string } }
  | { match?: string; model?: string; path?: string; latencyMs?: number; type: "chat-error"; status: number; body?: string }
  /** A 200 answer whose body is not JSON, so the provider reports `response was not JSON`. */
  | { match?: string; model?: string; path?: string; latencyMs?: number; type: "chat-malformed"; body?: string }
  /** A 200 JSON answer with no message content, so the provider reports `response had no content`. */
  | { match?: string; model?: string; path?: string; latencyMs?: number; type: "chat-empty" }
  /** A 200 answer whose content is not a JSON decision, so the provider reports `decision was not valid JSON`. */
  | { match?: string; model?: string; path?: string; latencyMs?: number; type: "decide-invalid"; text?: string }
  | { match?: string; model?: string; path?: string; latencyMs?: number; type: "decide"; result: unknown };

/**
 * A deterministic OpenAI-compatible `/v1/chat/completions` server, plus the Jev-style `/v1/systemone`
 * batch endpoint. `llm`/`decision` nodes and `openai`/`typesafe` providers talk to it; everything runs
 * offline. Rules match on the request, so a test can script a retry (first call fails, second answers)
 * and exact answers per prompt.
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
        const json = JSON.parse(text || "{}") as Record<string, unknown>;
        if (req.url?.includes("/v1/systemone")) return this.answerSystemone(req, res, json);
        if (req.url?.includes("/chat/completions") !== true) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        const messages = (json.messages ?? []) as { role: string; content: string }[];
        const tail = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const rule = this.pickRule(req.url ?? "", String(json.model ?? ""), tail);
        if (!rule) return noRuleLeft(res);
        const done = () => respondChat(res, rule, tail);
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

  /** Count of requests whose body contains every one of the given texts (e.g. model and question id). */
  countAll(...texts: string[]): number {
    return this.requests.filter((r) => texts.every((text) => r.includes(text))).length;
  }

  /** Index of the first request whose body contains the text, to assert the order of calls. */
  firstIndex(text: string): number {
    return this.requests.findIndex((r) => r.includes(text));
  }

  /**
   * Picks the rule for one request: a rule with `match` is consumed by the first matching request
   * (for retry scripting); otherwise the first default rule (no `match`) that fits `path` and `model`
   * stays, so one rule can answer every request.
   */
  private pickRule(url: string, model: string, promptText: string): Rule | undefined {
    const fits = (rule: Rule) => (rule.path === undefined || url.includes(rule.path)) && (rule.model === undefined || rule.model === model);
    const idx = this.rules.findIndex((rule) => rule.match !== undefined && promptText.includes(rule.match) && fits(rule));
    if (idx >= 0) return this.rules.splice(idx, 1)[0];
    return this.rules.find((rule) => rule.match === undefined && fits(rule));
  }

  /** `/v1/systemone`: Jev-style batch decisions, one answer object per question. */
  private answerSystemone(req: IncomingMessage, res: ServerResponse, json: Record<string, unknown>) {
    const questions = (json.questions ?? {}) as Record<string, { type?: string; instructions?: string }>;
    const promptText = Object.values(questions)[0]?.instructions ?? "";
    const rule = this.pickRule(req.url ?? "", String(json.model ?? ""), promptText);
    if (!rule) return noRuleLeft(res);
    const done = () => {
      if (rule.type === "chat-error") {
        res.writeHead(rule.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: rule.body ?? "provider error" }));
        return;
      }
      if (rule.type !== "decide") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `rule type "${rule.type}" cannot answer a systemone request` }));
        return;
      }
      // A `decide` rule answers every question of the batch with its result.
      const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, { type: question.type, ...(rule.result as object) }]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers }));
    };
    if (rule.latencyMs) setTimeout(done, rule.latencyMs); else done();
  }
}

function noRuleLeft(res: ServerResponse) {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no scripted answer left" }));
}

/** Sends one scripted answer for a `/chat/completions` request. */
function respondChat(res: ServerResponse, rule: Rule, promptText: string) {
  if (rule.type === "chat-error") {
    res.writeHead(rule.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: rule.body ?? "provider error" }));
    return;
  }
  if (rule.type === "chat-malformed") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rule.body ?? "this is not json");
    return;
  }
  if (rule.type === "chat-empty") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion", choices: [] }));
    return;
  }
  // `decide` rules answer with JSON in the message content, `decide-invalid` with non-JSON content.
  // `{{prompt}}` in a scripted text is replaced with the last user message, so one rule can echo
  // deterministically regardless of how many requests arrive.
  const content = rule.type === "decide-invalid"
    ? (rule.text ?? "definitely not json")
    : rule.type === "decide"
      ? JSON.stringify(rule.result)
      : rule.result.text.replace(/\{\{prompt\}\}/g, promptText);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}
