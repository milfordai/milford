import type { Result } from "@milfordai/core";
import { z } from "zod";
import { slack, slackConfig } from "./slack.js";
import { telegram, telegramConfig } from "./telegram.js";
import type { Channel, ChannelDeps } from "./types.js";
import { webhook, webhookConfig } from "./webhook.js";

export * from "./types.js";

const ChannelConfig = z.discriminatedUnion("type", [webhookConfig, slackConfig, telegramConfig]);

/** Validates channel configs and builds the adapters. Fails on unknown flows, duplicate ids and missing allowlists. */
export function createChannels(configs: unknown[], deps: ChannelDeps): Result<Channel[]> {
  const flows = new Set(deps.engine.flows().map((flow) => flow.id));
  const channels: Channel[] = [];
  for (const raw of configs) {
    const id = (raw as { id?: string })?.id ?? "?";
    const parsed = ChannelConfig.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `channel "${id}": ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}` };
    }

    const channel = parsed.data;
    if (channels.some((existing) => existing.id === channel.id)) return { ok: false, error: `duplicate channel id "${channel.id}"` };
    if (!flows.has(channel.flow)) return { ok: false, error: `channel "${channel.id}": unknown flow "${channel.flow}"` };

    channels.push(channel.type === "webhook" ? webhook(channel, deps) : channel.type === "slack" ? slack(channel, deps) : telegram(channel, deps));
  }
  return { ok: true, value: channels };
}
