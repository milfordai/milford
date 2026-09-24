import { TOO_MANY_RUNS, type Engine } from "@milfordai/core";
import type { InboundMessage, Log } from "./types.js";

const MAX_REPLY = 3800; // below Telegram's 4096 and Slack's recommended 4000 characters
const SEEN_MAX = 1000;

export type HandlerOptions = { id: string; type: string; engine: Engine; flow: string; allow: string[]; log: Log };

/**
 * Shared behaviour of chat channels: allowlist (deny by default), redelivery dedup, and a reply that never
 * leaks internal errors. Never throws.
 */
export function createHandler(options: HandlerOptions) {
  const seen = new Set<string>();
  const log = (level: string, message: string, extra: object = {}) => options.log(JSON.stringify({ level, msg: message, channel: options.id, ...extra }));

  return async (message: InboundMessage, reply: (text: string) => Promise<void>): Promise<void> => {
    if (!options.allow.includes(message.user)) return log("warn", "message from a user who is not allowed", { user: message.user });

    if (message.id) {
      if (seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    }

    const send = async (text: string) => {
      try {
        await reply(text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}...` : text);
      } catch (error) {
        log("error", "reply failed", { error: error instanceof Error ? error.message : String(error) });
      }
    };
    try {
      const result = await options.engine.run(options.flow, { text: message.text, user: message.user, conversation: message.conversation, channel: options.type });
      if (!result.ok && result.error === TOO_MANY_RUNS) {
        // Forget the message, so a redelivery retries it once the server is less busy.
        if (message.id) seen.delete(message.id);
        return send("Busy, try again shortly.");
      }

      const ok = result.ok && result.value.ok;
      log(ok ? "info" : "error", "run", { flow: options.flow, ok, runId: result.ok ? result.value.runId : undefined, error: result.ok ? undefined : result.error });
      // A failed run forgets the message too, so a redelivery retries instead of dropping it forever.
      if (message.id && !ok) seen.delete(message.id);
      const text = ok ? (result.value as { output?: { output?: string } }).output?.output : "Sorry, something went wrong.";
      if (text) await send(text);
    } catch (error) {
      if (message.id) seen.delete(message.id);
      log("error", "run crashed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
