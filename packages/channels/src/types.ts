import type { Engine } from "@milfordai/core";

export type Log = (line: string) => void;

export type ChannelDeps = {
  engine: Engine;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  log?: Log;
  /** Slack reconnect backoff start, in ms. Tests shorten it. */
  reconnectMs?: number;
};

/** A message from a chat channel, already normalized. */
export type InboundMessage = { text: string; user: string; conversation: string; /** Stable id used to drop redelivered events. */ id?: string };

export interface Channel {
  id: string;
  type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Webhook only: the server mounts this at POST /hooks/:id. */
  handle?(req: Request): Promise<Response>;
}
