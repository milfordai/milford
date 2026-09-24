import { createEngine, defaultRegistry, type Engine } from "@milfordai/core";
import { describe, expect, it } from "vitest";
import { createQueueConsumers } from "../src/queues.js";

const engineResult = createEngine({ registry: defaultRegistry(), flows: [{ id: "process-order", nodes: [{ id: "in", type: "input" }], edges: [] }] });
if (!engineResult.ok) throw new Error(engineResult.error);
const engine: Engine = engineResult.value;

const kafkaConfig = (overrides: Record<string, unknown> = {}) => ({
  id: "orders",
  type: "kafka",
  flow: "process-order",
  brokers: ["localhost:9092"],
  topics: ["orders"],
  groupId: "milford-orders",
  ...overrides,
});

describe("queue consumers wiring", () => {
  it("builds no consumers when none are configured (the default)", async () => {
    expect(await createQueueConsumers([], { engine })).toEqual({ ok: true, value: [] });
  });

  it("reports a consumer without a type", async () => {
    expect(await createQueueConsumers([{ id: "orders" }], { engine })).toEqual({ ok: false, error: 'queue consumer "orders": type is required' });
  });

  it("reports a consumer type no adapter package exists for", async () => {
    expect(await createQueueConsumers([kafkaConfig({ type: "mqtt" })], { engine })).toEqual({
      ok: false,
      error: 'queue consumer type "mqtt" is not supported (available: kafka)',
    });
  });

  it("reports duplicate consumer ids", async () => {
    expect(await createQueueConsumers([kafkaConfig(), kafkaConfig({ topics: ["other"] })], { engine })).toEqual({ ok: false, error: 'duplicate queue consumer id "orders"' });
  });

  it("loads the kafka adapter package lazily and validates its configs", async () => {
    const built = await createQueueConsumers([kafkaConfig({ brokers: [] })], { engine });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain('queue consumer "orders"');
    expect(built.ok === false && built.error).toContain("brokers");
  });

  it("builds one consumer per configured queue, validated by its adapter", async () => {
    const built = await createQueueConsumers([kafkaConfig(), kafkaConfig({ id: "returns", topics: ["returns"] })], { engine });
    expect(built).toMatchObject({ ok: true, value: [{ id: "orders", type: "kafka" }, { id: "returns", type: "kafka" }] });
  });

  it("reports an unknown flow through the adapter", async () => {
    expect(await createQueueConsumers([kafkaConfig({ flow: "nope" })], { engine })).toEqual({ ok: false, error: 'queue consumer "orders": unknown flow "nope"' });
  });
});
