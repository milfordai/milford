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
});

type SlackEvent = { type: string; user?: string; text?: string; channel: string; ts: string; thread_ts?: string; channel_type?: string; subtype?: string; bot_id?: string };

/**
 * Socket Mode: Milford opens an outbound WebSocket, so no public URL is needed. Handles DMs and @mentions,
 * acknowledges every envelope at once (Slack redelivers otherwise) and reconnects with backoff.
 */
export function slack(config: z.infer<typeof slackConfig>, deps: ChannelDeps): Channel {
  const doFetch = deps.fetch ?? fetch;
  const WS = deps.WebSocket ?? WebSocket;
  const log = deps.log ?? console.log;
  const stopCtl = new AbortController();
  const handle = createHandler({ id: config.id, type: "slack", engine: deps.engine, flow: config.flow, allow: config.allow, log });

  const api = async (method: string, token: string, body?: object) => {
    const response = await doFetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": body ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded" },
      body: body && JSON.stringify(body),
      signal: stopCtl.signal,
    });
    const json = (await response.json()) as { ok: boolean; error?: string; url?: string };
    if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? response.status}`);
    return json;
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopCtl.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

  function onEvent(eventId: string | undefined, event: SlackEvent) {
    const mention = event.type === "app_mention";
    const dm = event.type === "message" && event.channel_type === "im" && !event.subtype && !event.bot_id;
    if ((!mention && !dm) || !event.user || !event.text) return;

    const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;

    void handle({ text, user: event.user, conversation: event.channel, id: eventId }, async (reply) => {
      await api("chat.postMessage", config.botToken, { channel: event.channel, text: reply, ...(mention && { thread_ts: event.thread_ts ?? event.ts }) });
    });
  }

  /** One connection. Resolves when the socket closes; `onHello` fires once Slack confirms it. */
  async function connect(onHello: () => void): Promise<void> {
    const { url } = await api("apps.connections.open", config.appToken);
    await new Promise<void>((resolve) => {
      const ws = new WS(url!);
      stopCtl.signal.addEventListener("abort", () => ws.close(), { once: true });
      ws.addEventListener("message", (message: MessageEvent) => {
        let envelope: { type?: string; envelope_id?: string; payload?: { event_id?: string; event?: SlackEvent } };
        try {
          envelope = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === "hello") onHello();
        else if (envelope.type === "disconnect") ws.close();
        else if (envelope.type === "events_api" && envelope.payload?.event) onEvent(envelope.payload.event_id, envelope.payload.event);
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
      } catch (error) {
        if (stopCtl.signal.aborted) break;
        log(JSON.stringify({ level: "error", msg: "socket mode failed", channel: config.id, error: error instanceof Error ? error.message : String(error) }));
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  return {
    id: config.id,
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
