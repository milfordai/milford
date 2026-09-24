import { createEngine, defaultRegistry, flow, type Engine } from "@milfordai/core";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createChannels } from "../src/index.js";

const engineFor = (extra: Parameters<typeof flow>[0] = "echo"): Engine => {
  const engine = createEngine({
    registry: defaultRegistry(),
    flows: [flow(extra).node("p", "prompt", { template: "You said: {{input.text}}" }).node("out", "output").edge("p", "out").build(), flow("boom").node("p", "prompt", { template: "{{input.nope}}" }).node("out", "output").edge("p", "out").build()],
  });
  if (!engine.ok) throw new Error(engine.error);
  return engine.value;
};
const until = async (cond: () => unknown, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const quiet = () => {};
const build = (config: object, deps: object = {}) => {
  const result = createChannels([config], { engine: engineFor(), log: quiet, reconnectMs: 5, ...deps });
  if (!result.ok) throw new Error(result.error);
  return result.value[0]!;
};

describe("createChannels", () => {
  const engine = engineFor();
  const bad = (config: object) => {
    const result = createChannels([config], { engine });
    return result.ok ? "ok" : result.error;
  };
  it("refuses channels without an allowlist or secret (deny by default)", () => {
    expect(bad({ id: "t", type: "telegram", flow: "echo", botToken: "1:x", allow: [] })).toMatch(/allow/);
    expect(bad({ id: "s", type: "slack", flow: "echo", appToken: "xapp-1", botToken: "xoxb-1" })).toMatch(/allow/);
    expect(bad({ id: "w", type: "webhook", flow: "echo", secret: "short" })).toMatch(/secret/);
  });
  it("rejects unknown flows, unknown types and duplicate ids", () => {
    expect(bad({ id: "t", type: "telegram", flow: "nope", botToken: "1:x", allow: ["1"] })).toMatch(/unknown flow "nope"/);
    expect(bad({ id: "t", type: "sms", flow: "echo" })).toMatch(/channel "t"/);
    const config = { id: "t", type: "telegram", flow: "echo", botToken: "1:x", allow: ["1"] };
    expect(createChannels([config, config], { engine }).ok).toBe(false);
  });
});

describe("webhook", () => {
  const secret = "0123456789abcdef";
  const channel = build({ id: "w", type: "webhook", flow: "echo", secret });
  const sign = (body: string, ts = String(Math.floor(Date.now() / 1000)), key = secret) => ({ "x-milford-timestamp": ts, "x-milford-signature": `sha256=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}` });
  const send = (body: string, headers: Record<string, string>) => channel.handle!(new Request("http://x/hooks/w", { method: "POST", body, headers }));

  it("runs the flow for a correctly signed request", async () => {
    const body = JSON.stringify({ text: "hi" });
    const response = await send(body, sign(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, output: "You said: hi" });
  });
  it("rejects a bad signature, a wrong secret and a stale timestamp", async () => {
    const body = JSON.stringify({ text: "hi" });
    expect((await send(body, { ...sign(body), "x-milford-signature": "sha256=00" })).status).toBe(401);
    expect((await send(body, sign(body, undefined, "another-secret-value"))).status).toBe(401);
    expect((await send(body, sign(body, String(Math.floor(Date.now() / 1000) - 3600)))).status).toBe(401);
    expect((await send(body, {})).status).toBe(401);
  });
  it("rejects a malformed signature with 401, never a crash", async () => {
    const body = JSON.stringify({ text: "hi" });
    expect((await send(body, { ...sign(body), "x-milford-signature": `sha256=${"é".repeat(64)}` })).status).toBe(401); // multibyte, not hex
    expect((await send(body, { ...sign(body), "x-milford-signature": "sha256=deadbeef" })).status).toBe(401); // hex, wrong length
    expect((await send(body, { ...sign(body), "x-milford-signature": "sha256" })).status).toBe(401); // empty digest
  });
  it("rejects a signed body that is not a JSON object", async () => {
    expect((await send("[1]", sign("[1]"))).status).toBe(400);
    expect((await send("{", sign("{"))).status).toBe(400);
  });
});

describe("when the engine is busy", () => {
  const busy = () => {
    const engine = createEngine({ registry: defaultRegistry(), flows: [flow("echo").node("p", "prompt", { template: "x" }).node("out", "output").edge("p", "out").build()], maxConcurrentRuns: 0 });
    if (!engine.ok) throw new Error(engine.error);
    return engine.value;
  };
  it("answers a webhook with 503", async () => {
    const secret = "0123456789abcdef";
    const channel = build({ id: "w", type: "webhook", flow: "echo", secret }, { engine: busy() });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.{}`).digest("hex")}`;
    expect((await channel.handle!(new Request("http://x/hooks/w", { method: "POST", body: "{}", headers: { "x-milford-timestamp": ts, "x-milford-signature": sig } }))).status).toBe(503);
  });
  it("tells a chat user to try again", async () => {
    const sent: string[] = [];
    let served = false;
    const fetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/sendMessage")) return (sent.push(JSON.parse(init.body as string).text), new Response(JSON.stringify({ ok: true, result: {} })));
      if (!served) return ((served = true), new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { text: "hi", from: { id: 42 }, chat: { id: 1 } } }] })));
      return new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    }) as unknown as typeof globalThis.fetch;
    const channel = build({ id: "t", type: "telegram", flow: "echo", botToken: "1:x", allow: ["42"] }, { engine: busy(), fetch });
    await channel.start();
    await until(() => sent.length);
    await channel.stop();
    expect(sent).toEqual(["Busy, try again shortly."]);
  });
});

describe("telegram", () => {
  const mockTelegram = (updates: unknown[][]) => {
    const sent: { chat_id: number; text: string }[] = [];
    const polls: object[] = [];
    let index = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      const method = url.split("/").pop();
      const body = JSON.parse(init.body as string);
      if (method === "sendMessage") {
        sent.push(body);
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      polls.push(body);
      if (index < updates.length) return new Response(JSON.stringify({ ok: true, result: updates[index++] }));
      // Idle long poll: hang until the channel stops.
      return new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent, polls };
  };
  const config = { id: "t", type: "telegram", flow: "echo", botToken: "123:SECRET", allow: ["42"] };
  const msg = (updateId: number, fromId: number, text: string) => ({ update_id: updateId, message: { text, from: { id: fromId }, chat: { id: 900 + fromId } } });

  it("answers allowed users, ignores others, and advances the offset", async () => {
    const mock = mockTelegram([[msg(1, 42, "lights on"), msg(2, 7, "let me in"), msg(3, 42, "bye")]]);
    const channel = build(config, { fetch: mock.fetch });
    await channel.start();
    await until(() => mock.sent.length >= 2);
    await channel.stop();
    expect(mock.sent.map((sent) => sent.text).sort()).toEqual(["You said: bye", "You said: lights on"]);
    expect(mock.sent.every((sent) => sent.chat_id === 942)).toBe(true);
    expect(mock.polls[1]).toMatchObject({ offset: 4 });
  });

  it("replies with a generic message when the flow fails, never the internal error", async () => {
    const mock = mockTelegram([[msg(1, 42, "x")]]);
    const channel = build({ ...config, flow: "boom" }, { fetch: mock.fetch });
    await channel.start();
    await until(() => mock.sent.length);
    await channel.stop();
    expect(mock.sent[0]!.text).toBe("Sorry, something went wrong.");
  });

  it("retries a message whose flow failed when the server redelivers it", async () => {
    const sent: { chat_id: number; text: string }[] = [];
    let polls = 0;
    const update = msg(1, 42, "x");
    const fetch = (async (url: string, init: RequestInit) => {
      const method = url.split("/").pop();
      if (method === "sendMessage") return (sent.push(JSON.parse(init.body as string)), new Response(JSON.stringify({ ok: true, result: {} })));
      polls += 1;
      // The redelivery is served only after the first attempt has replied, so it cannot race the retry mark.
      if (polls === 2) await until(() => sent.length >= 1);
      if (polls > 2) return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))); // idle poll: hang until the channel stops
      return new Response(JSON.stringify({ ok: true, result: [update] }));
    }) as unknown as typeof globalThis.fetch;
    const channel = build({ ...config, flow: "boom" }, { fetch });
    await channel.start();
    await until(() => sent.length >= 2);
    await channel.stop();
    expect(sent.map((entry) => entry.text)).toEqual(["Sorry, something went wrong.", "Sorry, something went wrong."]);
  });

  it("keeps polling after a network error", async () => {
    let calls = 0;
    const mock = mockTelegram([[msg(1, 42, "hi")]]);
    const flaky = (async (url: string, init: RequestInit) => {
      if (++calls === 1) throw new Error("network down");
      return mock.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const channel = build(config, { fetch: flaky });
    await channel.start();
    await until(() => mock.sent.length);
    await channel.stop();
    expect(mock.sent[0]!.text).toBe("You said: hi");
  });

  it("does not put the bot token in log lines", async () => {
    const logs: string[] = [];
    const fail = (async () => { throw new Error("boom"); }) as unknown as typeof globalThis.fetch;
    const channel = build(config, { fetch: fail, log: (line: string) => logs.push(line) });
    await channel.start();
    await until(() => logs.length);
    await channel.stop();
    expect(logs.join("")).not.toContain("SECRET");
  });
});

describe("slack socket mode", () => {
  type Listener = (event: { data?: string }) => void;
  class FakeWS {
    static all: FakeWS[] = [];
    sent: string[] = [];
    listeners: Record<string, Listener[]> = {};
    closed = false;
    constructor(public url: string) { FakeWS.all.push(this); }
    addEventListener(type: string, listener: Listener) { (this.listeners[type] ??= []).push(listener); }
    send(data: string) { this.sent.push(data); }
    close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
    emit(type: string, event: { data?: string } = {}) { this.listeners[type]?.forEach((listener) => listener(event)); }
    deliver(message: object) { this.emit("message", { data: JSON.stringify(message) }); }
  }
  const setup = () => {
    FakeWS.all = [];
    const posts: { channel: string; text: string; thread_ts?: string }[] = [];
    let opens = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      const method = url.split("/").pop();
      if (method === "apps.connections.open") return new Response(JSON.stringify({ ok: true, url: `wss://slack.test/${++opens}` }));
      posts.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof globalThis.fetch;
    const channel = build({ id: "s", type: "slack", flow: "echo", appToken: "xapp-1", botToken: "xoxb-1", allow: ["U1"] }, { fetch, WebSocket: FakeWS as unknown as typeof WebSocket });
    return { channel, posts, socket: async (index = 0) => (await until(() => FakeWS.all[index]), FakeWS.all[index]!) };
  };
  const event = (envelope_id: string, event_id: string, event: object) => ({ type: "events_api", envelope_id, payload: { event_id, event: { channel: "C1", ts: "1.1", ...event } } });

  it("acks each envelope, replies in the thread to a mention, and strips the mention", async () => {
    const { channel, posts, socket } = setup();
    await channel.start();
    const ws = await socket();
    ws.deliver({ type: "hello" });
    ws.deliver(event("e1", "Ev1", { type: "app_mention", user: "U1", text: "<@UBOT> lock up" }));
    await until(() => posts.length);
    expect(ws.sent).toContain(JSON.stringify({ envelope_id: "e1" }));
    expect(posts[0]).toEqual({ channel: "C1", text: "You said: lock up", thread_ts: "1.1" });
    await channel.stop();
  });

  it("answers DMs without a thread, and ignores bots, other users and redelivered events", async () => {
    const { channel, posts, socket } = setup();
    await channel.start();
    const ws = await socket();
    ws.deliver(event("e1", "Ev1", { type: "message", channel_type: "im", user: "U1", text: "hi" }));
    ws.deliver(event("e2", "Ev1", { type: "message", channel_type: "im", user: "U1", text: "hi" })); // redelivery
    ws.deliver(event("e3", "Ev3", { type: "message", channel_type: "im", user: "U1", text: "x", bot_id: "B1" }));
    ws.deliver(event("e4", "Ev4", { type: "message", channel_type: "im", user: "U9", text: "let me in" }));
    ws.deliver(event("e5", "Ev5", { type: "message", channel_type: "channel", user: "U1", text: "chatter" }));
    await until(() => posts.length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posts).toEqual([{ channel: "C1", text: "You said: hi" }]);
    expect(ws.sent).toHaveLength(5); // every envelope is acknowledged, even ignored ones
    await channel.stop();
  });

  it("reconnects after a disconnect request", async () => {
    const { channel, socket } = setup();
    await channel.start();
    const ws = await socket();
    ws.deliver({ type: "disconnect", reason: "refresh_requested" });
    const second = await socket(1);
    expect(second.url).toBe("wss://slack.test/2");
    await channel.stop();
  });
});
