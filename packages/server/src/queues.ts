import type { Engine, QueueConsumer, Result } from "@milfordai/core";

/** What every queue adapter package takes from the server: the engine plus a log line sink. */
export type QueueAdapterDeps = { engine: Engine; log?: (line: string) => void };

/** The factory contract every adapter package exports, so any broker can be loaded the same way. */
export type QueueAdapter = { createConsumers(configs: unknown[], deps: QueueAdapterDeps): Result<QueueConsumer[]> };

/**
 * The adapter package of each consumer `type`, loaded lazily: a broker's SDK is only installed when one of
 * its consumers is configured, so the default install stays lean. Each package is named
 * `@milfordai/queues-<type>` and exports `createConsumers`.
 */
const adapters: Record<string, () => Promise<QueueAdapter>> = {
  kafka: () => import("@milfordai/queues-kafka"),
};

/** Builds one consumer per config, grouping by `type` and loading each adapter package once. Never throws. */
export async function createQueueConsumers(configs: unknown[], deps: QueueAdapterDeps): Promise<Result<QueueConsumer[]>> {
  const groups = new Map<string, unknown[]>();
  const ids = new Set<string>();
  for (const config of configs) {
    const id = (config as { id?: string })?.id ?? "?";
    const type = (config as { type?: string })?.type;
    if (typeof type !== "string" || !type) return { ok: false, error: `queue consumer "${id}": type is required` };
    if (ids.has(id)) return { ok: false, error: `duplicate queue consumer id "${id}"` };
    ids.add(id);
    groups.set(type, [...(groups.get(type) ?? []), config]);
  }

  const consumers: QueueConsumer[] = [];
  for (const [type, group] of groups) {
    const load = adapters[type];
    if (!load) return { ok: false, error: `queue consumer type "${type}" is not supported (available: ${Object.keys(adapters).join(", ")})` };
    let adapter: QueueAdapter;
    try {
      adapter = await load();
    } catch {
      return { ok: false, error: `queue consumer type "${type}" needs its adapter package @milfordai/queues-${type}; install it or remove these consumers` };
    }
    const result = adapter.createConsumers(group, deps);
    if (!result.ok) return { ok: false, error: result.error };
    consumers.push(...result.value);
  }
  return { ok: true, value: consumers };
}
