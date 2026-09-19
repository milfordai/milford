import type { Engine } from "@loage/core";
import type { InboundMessage, Log } from "./types.js";

const MAX_REPLY = 3800; // below Telegram's 4096 and Slack's recommended 4000 characters
const SEEN_MAX = 1000;

export type HandlerOptions = { id: string; type: string; engine: Engine; flow: string; allow: string[]; log: Log; runTimeoutMs?: number; maxConcurrent?: number };

/**
 * Shared behaviour of chat channels: allowlist (deny by default), redelivery dedup, a cap on concurrent runs,
 * and a reply that never leaks internal errors. Never throws.
 */
export function createHandler(o: HandlerOptions) {
  const seen = new Set<string>();
  let active = 0;
  const log = (level: string, msg: string, extra: object = {}) => o.log(JSON.stringify({ level, msg, channel: o.id, ...extra }));

  return async (msg: InboundMessage, reply: (text: string) => Promise<void>): Promise<void> => {
    if (!o.allow.includes(msg.user)) return log("warn", "message from a user who is not allowed", { user: msg.user });
    if (msg.id) {
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    }
    const send = async (text: string) => {
      try {
        await reply(text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}...` : text);
      } catch (e) {
        log("error", "reply failed", { error: e instanceof Error ? e.message : String(e) });
      }
    };
    if (active >= (o.maxConcurrent ?? 4)) return send("Busy, try again shortly.");
    active++;
    try {
      const r = await o.engine.run(o.flow, { text: msg.text, user: msg.user, conversation: msg.conversation, channel: o.type }, { timeoutMs: o.runTimeoutMs });
      const ok = r.ok && r.value.ok;
      log(ok ? "info" : "error", "run", { flow: o.flow, ok, runId: r.ok ? r.value.runId : undefined, error: r.ok ? undefined : r.error });
      const text = ok ? (r.value as { output?: { output?: string } }).output?.output : "Sorry, something went wrong.";
      if (text) await send(text);
    } catch (e) {
      log("error", "run crashed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      active--;
    }
  };
}
