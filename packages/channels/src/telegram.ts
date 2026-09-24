import { z } from "zod";
import { createHandler } from "./handler.js";
import type { Channel, ChannelDeps } from "./types.js";

export const telegramConfig = z.object({
  id: z.string(),
  type: z.literal("telegram"),
  flow: z.string(),
  botToken: z.string().min(1),
  /** Telegram user ids allowed to run the flow. Required: channels are deny by default. */
  allow: z.array(z.string()).min(1),
  pollTimeoutSec: z.number().int().positive().default(30),
});

type Update = { update_id: number; message?: { text?: string; from?: { id: number; is_bot?: boolean }; chat: { id: number } } };

/** Long polling over `getUpdates`: no public URL and no inbound port. */
export function telegram(config: z.infer<typeof telegramConfig>, deps: ChannelDeps): Channel {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? console.log;
  const stopCtl = new AbortController();
  const handle = createHandler({ id: config.id, type: "telegram", engine: deps.engine, flow: config.flow, allow: config.allow, log });
  // The token is part of the URL, so errors must never echo it.
  const call = async (method: string, body: object, signal?: AbortSignal) => {
    const response = await doFetch(`https://api.telegram.org/bot${config.botToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const json = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? response.status}`);
    return json.result;
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopCtl.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

  let loop: Promise<void> | undefined;
  async function poll() {
    let offset = 0;
    let delay = deps.reconnectMs ?? 1000;
    while (!stopCtl.signal.aborted) {
      try {
        const updates = (await call("getUpdates", { offset, timeout: config.pollTimeoutSec, allowed_updates: ["message"] }, stopCtl.signal)) as Update[];
        delay = deps.reconnectMs ?? 1000;
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text || !message.from || message.from.is_bot) continue;
          // Not awaited: a slow flow must not stall polling.
          void handle({ text: message.text, user: String(message.from.id), conversation: String(message.chat.id), id: `tg-${update.update_id}` }, async (text) => void (await call("sendMessage", { chat_id: message.chat.id, text })));
        }
      } catch (error) {
        if (stopCtl.signal.aborted) break;
        log(JSON.stringify({ level: "error", msg: "poll failed", channel: config.id, error: error instanceof Error ? error.message : String(error) }));
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
  return {
    id: config.id,
    type: "telegram",
    async start() {
      loop = poll();
    },
    async stop() {
      stopCtl.abort();
      await loop;
    },
  };
}
