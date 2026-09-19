import type { Result } from "@milford/core";
import { z } from "zod";
import { slack, slackConfig } from "./slack.js";
import { telegram, telegramConfig } from "./telegram.js";
import type { Channel, ChannelDeps } from "./types.js";
import { webhook, webhookConfig } from "./webhook.js";

export * from "./types.js";

const ChannelConfig = z.discriminatedUnion("type", [webhookConfig, slackConfig, telegramConfig]);

/** Validates channel configs and builds the adapters. Fails on unknown flows, duplicate ids and missing allowlists. */
export function createChannels(configs: unknown[], deps: ChannelDeps): Result<Channel[]> {
  const flows = new Set(deps.engine.flows().map((f) => f.id));
  const channels: Channel[] = [];
  for (const raw of configs) {
    const p = ChannelConfig.safeParse(raw);
    const id = (raw as { id?: string })?.id ?? "?";
    if (!p.success) return { ok: false, error: `channel "${id}": ${p.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}` };
    const c = p.data;
    if (channels.some((x) => x.id === c.id)) return { ok: false, error: `duplicate channel id "${c.id}"` };
    if (!flows.has(c.flow)) return { ok: false, error: `channel "${c.id}": unknown flow "${c.flow}"` };
    channels.push(c.type === "webhook" ? webhook(c, deps) : c.type === "slack" ? slack(c, deps) : telegram(c, deps));
  }
  return { ok: true, value: channels };
}
