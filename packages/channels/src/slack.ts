import { z } from "zod";
import { createHandler } from "./handler.js";
import type { Channel, ChannelDeps } from "./types.js";

export const slackConfig = z.object({
  id: z.string(),
  type: z.literal("slack"),
  flow: z.string(),
  /** App-level token (`xapp-`, scope connections:write) for Socket Mode. */
  appToken: z.string().startsWith("xapp-"),
  /** Bot token (`xoxb-`) for posting replies. */
  botToken: z.string().startsWith("xoxb-"),
  /** Slack user ids (`U...`) allowed to run the flow. Required: channels are deny by default. */
  allow: z.array(z.string()).min(1),
  apiBase: z.string().default("https://slack.com/api"),
});

type SlackEvent = { type: string; user?: string; text?: string; channel: string; ts: string; thread_ts?: string; channel_type?: string; subtype?: string; bot_id?: string };

/**
 * Socket Mode: Loage opens an outbound WebSocket, so no public URL is needed. Handles DMs and @mentions,
 * acknowledges every envelope at once (Slack redelivers otherwise) and reconnects with backoff.
 */
export function slack(cfg: z.infer<typeof slackConfig>, deps: ChannelDeps): Channel {
  const doFetch = deps.fetch ?? fetch;
  const WS = deps.WebSocket ?? WebSocket;
  const log = deps.log ?? console.log;
  const stopCtl = new AbortController();
  const handle = createHandler({ id: cfg.id, type: "slack", engine: deps.engine, flow: cfg.flow, allow: cfg.allow, log });

  const api = async (method: string, token: string, body?: object) => {
    const res = await doFetch(`${cfg.apiBase}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": body ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded" },
      body: body && JSON.stringify(body),
      signal: stopCtl.signal,
    });
    const json = (await res.json()) as { ok: boolean; error?: string; url?: string };
    if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? res.status}`);
    return json;
  };
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); stopCtl.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true }); });

  function onEvent(eventId: string | undefined, ev: SlackEvent) {
    const mention = ev.type === "app_mention";
    const dm = ev.type === "message" && ev.channel_type === "im" && !ev.subtype && !ev.bot_id;
    if ((!mention && !dm) || !ev.user || !ev.text) return;
    const text = ev.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;
    void handle({ text, user: ev.user, conversation: ev.channel, id: eventId }, async (reply) => {
      await api("chat.postMessage", cfg.botToken, { channel: ev.channel, text: reply, ...(mention && { thread_ts: ev.thread_ts ?? ev.ts }) });
    });
  }

  /** One connection. Resolves when the socket closes; `onHello` fires once Slack confirms it. */
  async function connect(onHello: () => void): Promise<void> {
    const { url } = await api("apps.connections.open", cfg.appToken);
    await new Promise<void>((resolve) => {
      const ws = new WS(url!);
      stopCtl.signal.addEventListener("abort", () => ws.close(), { once: true });
      ws.addEventListener("message", (e: MessageEvent) => {
        let m: { type?: string; envelope_id?: string; payload?: { event_id?: string; event?: SlackEvent } };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.envelope_id) ws.send(JSON.stringify({ envelope_id: m.envelope_id }));
        if (m.type === "hello") onHello();
        else if (m.type === "disconnect") ws.close();
        else if (m.type === "events_api" && m.payload?.event) onEvent(m.payload.event_id, m.payload.event);
      });
      ws.addEventListener("close", () => resolve());
      ws.addEventListener("error", () => {});
    });
  }

  let loop: Promise<void> | undefined;
  async function run() {
    const base = deps.reconnectMs ?? 1000;
    let delay = base;
    while (!stopCtl.signal.aborted) {
      try {
        await connect(() => (delay = base));
      } catch (e) {
        if (stopCtl.signal.aborted) break;
        log(JSON.stringify({ level: "error", msg: "socket mode failed", channel: cfg.id, error: e instanceof Error ? e.message : String(e) }));
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  return {
    id: cfg.id,
    type: "slack",
    async start() {
      loop = run();
    },
    async stop() {
      stopCtl.abort();
      await loop;
    },
  };
}
