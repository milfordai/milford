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
  /** Override for tests or a local Bot API server. */
  apiBase: z.string().default("https://api.telegram.org"),
});

type Update = { update_id: number; message?: { text?: string; from?: { id: number; is_bot?: boolean }; chat: { id: number } } };

/** Long polling over `getUpdates`: no public URL and no inbound port. */
export function telegram(cfg: z.infer<typeof telegramConfig>, deps: ChannelDeps): Channel {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? console.log;
  const stopCtl = new AbortController();
  const handle = createHandler({ id: cfg.id, type: "telegram", engine: deps.engine, flow: cfg.flow, allow: cfg.allow, log, runTimeoutMs: deps.runTimeoutMs });
  // The token is part of the URL, so errors must never echo it.
  const call = async (method: string, body: object, signal?: AbortSignal) => {
    const res = await doFetch(`${cfg.apiBase}/bot${cfg.botToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  };
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); stopCtl.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true }); });

  let loop: Promise<void> | undefined;
  async function poll() {
    let offset = 0;
    let delay = deps.reconnectMs ?? 1000;
    while (!stopCtl.signal.aborted) {
      try {
        const updates = (await call("getUpdates", { offset, timeout: cfg.pollTimeoutSec, allowed_updates: ["message"] }, stopCtl.signal)) as Update[];
        delay = deps.reconnectMs ?? 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text || !m.from || m.from.is_bot) continue;
          // Not awaited: a slow flow must not stall polling.
          void handle({ text: m.text, user: String(m.from.id), conversation: String(m.chat.id), id: `tg-${u.update_id}` }, async (text) => void (await call("sendMessage", { chat_id: m.chat.id, text })));
        }
      } catch (e) {
        if (stopCtl.signal.aborted) break;
        log(JSON.stringify({ level: "error", msg: "poll failed", channel: cfg.id, error: e instanceof Error ? e.message : String(e) }));
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
  return {
    id: cfg.id,
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
