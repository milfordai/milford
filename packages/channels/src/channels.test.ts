import { createEngine, defaultRegistry, flow, type Engine } from "@loage/core";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createChannels } from "./index.js";

const engineFor = (extra: Parameters<typeof flow>[0] = "echo"): Engine => {
  const e = createEngine({
    registry: defaultRegistry(),
    flows: [flow(extra).node("p", "prompt", { template: "You said: {{input.text}}" }).node("out", "output").edge("p", "out").build(), flow("boom").node("p", "prompt", { template: "{{input.nope}}" }).node("out", "output").edge("p", "out").build()],
  });
  if (!e.ok) throw new Error(e.error);
  return e.value;
};
const until = async (cond: () => unknown, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const quiet = () => {};
const build = (config: object, deps: object = {}) => {
  const r = createChannels([config], { engine: engineFor(), log: quiet, reconnectMs: 5, ...deps });
  if (!r.ok) throw new Error(r.error);
  return r.value[0]!;
};

describe("createChannels", () => {
  const e = engineFor();
  const bad = (c: object) => {
    const r = createChannels([c], { engine: e });
    return r.ok ? "ok" : r.error;
  };
  it("refuses channels without an allowlist or secret (deny by default)", () => {
    expect(bad({ id: "t", type: "telegram", flow: "echo", botToken: "1:x", allow: [] })).toMatch(/allow/);
    expect(bad({ id: "s", type: "slack", flow: "echo", appToken: "xapp-1", botToken: "xoxb-1" })).toMatch(/allow/);
    expect(bad({ id: "w", type: "webhook", flow: "echo", secret: "short" })).toMatch(/secret/);
  });
  it("rejects unknown flows, unknown types and duplicate ids", () => {
    expect(bad({ id: "t", type: "telegram", flow: "nope", botToken: "1:x", allow: ["1"] })).toMatch(/unknown flow "nope"/);
    expect(bad({ id: "t", type: "sms", flow: "echo" })).toMatch(/channel "t"/);
    const c = { id: "t", type: "telegram", flow: "echo", botToken: "1:x", allow: ["1"] };
    expect(createChannels([c, c], { engine: e }).ok).toBe(false);
  });
});

describe("webhook", () => {
  const secret = "0123456789abcdef";
  const ch = build({ id: "w", type: "webhook", flow: "echo", secret });
  const sign = (body: string, ts = String(Math.floor(Date.now() / 1000)), key = secret) => ({ "x-loage-timestamp": ts, "x-loage-signature": `sha256=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}` });
  const send = (body: string, headers: Record<string, string>) => ch.handle!(new Request("http://x/hooks/w", { method: "POST", body, headers }));

  it("runs the flow for a correctly signed request", async () => {
    const body = JSON.stringify({ text: "hi" });
    const res = await send(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, output: "You said: hi" });
  });
  it("rejects a bad signature, a wrong secret and a stale timestamp", async () => {
    const body = JSON.stringify({ text: "hi" });
    expect((await send(body, { ...sign(body), "x-loage-signature": "sha256=00" })).status).toBe(401);
    expect((await send(body, sign(body, undefined, "another-secret-value"))).status).toBe(401);
    expect((await send(body, sign(body, String(Math.floor(Date.now() / 1000) - 3600)))).status).toBe(401);
    expect((await send(body, {})).status).toBe(401);
  });
  it("rejects a signed body that is not a JSON object", async () => {
    expect((await send("[1]", sign("[1]"))).status).toBe(400);
    expect((await send("{", sign("{"))).status).toBe(400);
  });
});

describe("telegram", () => {
  const mockTelegram = (updates: unknown[][]) => {
    const sent: { chat_id: number; text: string }[] = [];
    const polls: object[] = [];
    let n = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      const method = url.split("/").pop();
      const body = JSON.parse(init.body as string);
      if (method === "sendMessage") {
        sent.push(body);
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      polls.push(body);
      if (n < updates.length) return new Response(JSON.stringify({ ok: true, result: updates[n++] }));
      // Idle long poll: hang until the channel stops.
      return new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent, polls };
  };
  const cfg = { id: "t", type: "telegram", flow: "echo", botToken: "123:SECRET", allow: ["42"] };
  const msg = (update_id: number, from: number, text: string) => ({ update_id, message: { text, from: { id: from }, chat: { id: 900 + from } } });

  it("answers allowed users, ignores others, and advances the offset", async () => {
    const m = mockTelegram([[msg(1, 42, "lights on"), msg(2, 7, "let me in"), msg(3, 42, "bye")]]);
    const ch = build(cfg, { fetch: m.fetch });
    await ch.start();
    await until(() => m.sent.length >= 2);
    await ch.stop();
    expect(m.sent.map((s) => s.text).sort()).toEqual(["You said: bye", "You said: lights on"]);
    expect(m.sent.every((s) => s.chat_id === 942)).toBe(true);
    expect(m.polls[1]).toMatchObject({ offset: 4 });
  });

  it("replies with a generic message when the flow fails, never the internal error", async () => {
    const m = mockTelegram([[msg(1, 42, "x")]]);
    const ch = build({ ...cfg, flow: "boom" }, { fetch: m.fetch });
    await ch.start();
    await until(() => m.sent.length);
    await ch.stop();
    expect(m.sent[0]!.text).toBe("Sorry, something went wrong.");
  });

  it("keeps polling after a network error", async () => {
    let calls = 0;
    const m = mockTelegram([[msg(1, 42, "hi")]]);
    const flaky = (async (url: string, init: RequestInit) => {
      if (++calls === 1) throw new Error("network down");
      return m.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const ch = build(cfg, { fetch: flaky });
    await ch.start();
    await until(() => m.sent.length);
    await ch.stop();
    expect(m.sent[0]!.text).toBe("You said: hi");
  });

  it("does not put the bot token in log lines", async () => {
    const logs: string[] = [];
    const fail = (async () => { throw new Error("boom"); }) as unknown as typeof globalThis.fetch;
    const ch = build(cfg, { fetch: fail, log: (l: string) => logs.push(l) });
    await ch.start();
    await until(() => logs.length);
    await ch.stop();
    expect(logs.join("")).not.toContain("SECRET");
  });
});

describe("slack socket mode", () => {
  type Listener = (e: { data?: string }) => void;
  class FakeWS {
    static all: FakeWS[] = [];
    sent: string[] = [];
    listeners: Record<string, Listener[]> = {};
    closed = false;
    constructor(public url: string) { FakeWS.all.push(this); }
    addEventListener(t: string, l: Listener) { (this.listeners[t] ??= []).push(l); }
    send(d: string) { this.sent.push(d); }
    close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
    emit(t: string, e: { data?: string } = {}) { this.listeners[t]?.forEach((l) => l(e)); }
    deliver(m: object) { this.emit("message", { data: JSON.stringify(m) }); }
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
    const ch = build({ id: "s", type: "slack", flow: "echo", appToken: "xapp-1", botToken: "xoxb-1", allow: ["U1"] }, { fetch, WebSocket: FakeWS as unknown as typeof WebSocket });
    return { ch, posts, socket: async (n = 0) => (await until(() => FakeWS.all[n]), FakeWS.all[n]!) };
  };
  const event = (envelope_id: string, event_id: string, ev: object) => ({ type: "events_api", envelope_id, payload: { event_id, event: { channel: "C1", ts: "1.1", ...ev } } });

  it("acks each envelope, replies in the thread to a mention, and strips the mention", async () => {
    const { ch, posts, socket } = setup();
    await ch.start();
    const ws = await socket();
    ws.deliver({ type: "hello" });
    ws.deliver(event("e1", "Ev1", { type: "app_mention", user: "U1", text: "<@UBOT> lock up" }));
    await until(() => posts.length);
    expect(ws.sent).toContain(JSON.stringify({ envelope_id: "e1" }));
    expect(posts[0]).toEqual({ channel: "C1", text: "You said: lock up", thread_ts: "1.1" });
    await ch.stop();
  });

  it("answers DMs without a thread, and ignores bots, other users and redelivered events", async () => {
    const { ch, posts, socket } = setup();
    await ch.start();
    const ws = await socket();
    ws.deliver(event("e1", "Ev1", { type: "message", channel_type: "im", user: "U1", text: "hi" }));
    ws.deliver(event("e2", "Ev1", { type: "message", channel_type: "im", user: "U1", text: "hi" })); // redelivery
    ws.deliver(event("e3", "Ev3", { type: "message", channel_type: "im", user: "U1", text: "x", bot_id: "B1" }));
    ws.deliver(event("e4", "Ev4", { type: "message", channel_type: "im", user: "U9", text: "let me in" }));
    ws.deliver(event("e5", "Ev5", { type: "message", channel_type: "channel", user: "U1", text: "chatter" }));
    await until(() => posts.length);
    await new Promise((r) => setTimeout(r, 30));
    expect(posts).toEqual([{ channel: "C1", text: "You said: hi" }]);
    expect(ws.sent).toHaveLength(5); // every envelope is acknowledged, even ignored ones
    await ch.stop();
  });

  it("reconnects after a disconnect request", async () => {
    const { ch, socket } = setup();
    await ch.start();
    const ws = await socket();
    ws.deliver({ type: "disconnect", reason: "refresh_requested" });
    const second = await socket(1);
    expect(second.url).toBe("wss://slack.test/2");
    await ch.stop();
  });
});
