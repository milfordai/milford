import { describe, expect, it } from "vitest";
import {
  createEngine,
  defaultRegistry,
  dispositionFor,
  memoryMessageIdempotency,
  messageToInput,
  retryDelayFor,
  runResultToOutcome,
  TOO_MANY_RUNS,
  type Engine,
  type MessageDisposition,
  type MessageIdempotency,
  type QueueMessage,
  type QueueRetryPolicy,
} from "../src/index.js";

// The node fixtures mirror engine.test.ts: runs are real engine runs, so the mapping rules below see the
// exact result shapes a flow produces.
let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));
const registry = defaultRegistry()
  .registerNode("ok", { run: async () => ({ success: true, output: "done" }) })
  .registerNode("fail", { run: async () => ({ success: false, error: "the model is unavailable" }) })
  .registerNode("gated", { run: async () => (await gate, { success: true }) })
  .registerNode("hang", { run: (context) => new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ success: false, error: "aborted" }))) });
const flows = [
  { id: "ok", nodes: [{ id: "a", type: "ok" }], edges: [] },
  { id: "fail", nodes: [{ id: "a", type: "fail" }], edges: [] },
  { id: "gated", nodes: [{ id: "a", type: "gated" }], edges: [] },
  { id: "hang", nodes: [{ id: "a", type: "hang" }], edges: [] },
];
const makeEngine = (extra: Record<string, unknown> = {}): Engine => {
  const engine = createEngine({ registry, flows, ...extra });
  if (!engine.ok) throw new Error(engine.error);
  return engine.value;
};

const encoder = new TextEncoder();
const message = (overrides: Partial<QueueMessage> = {}): QueueMessage => {
  const payload = encoder.encode(JSON.stringify({ order: 7 }));
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    body = undefined;
  }
  return { id: "orders/0/1", queue: "orders", payload, body, deliveryCount: 1, ...overrides };
};

/**
 * A fake broker: delivers a message, records the settlement the handler returns, and redelivers retries
 * with a grown `deliveryCount` until the message settles. It is the at-least-once delivery half of the port.
 * Redeliveries stop at `maxDeliveries` (the broker gives up, like a consumer that shut down).
 */
class FakeBroker {
  readonly settlements: { id: string; action: string }[] = [];
  readonly retries: { id: string; delayMs?: number; deliveryCount: number }[] = [];
  deliveries = 0;

  constructor(readonly policy: QueueRetryPolicy, readonly maxDeliveries = policy.attempts) {}

  async consume(input: QueueMessage, handler: (delivery: QueueMessage) => Promise<MessageDisposition>): Promise<void> {
    this.deliveries++;
    const disposition = await handler(input);
    if (disposition.action === "retry") {
      this.retries.push({ id: input.id, delayMs: disposition.delayMs, deliveryCount: input.deliveryCount });
      if (input.deliveryCount >= this.maxDeliveries) return; // the broker stops here; the message stays unsettled
      return this.consume({ ...input, deliveryCount: input.deliveryCount + 1 }, handler);
    }
    this.settlements.push({ id: input.id, action: disposition.action });
  }
}

/** The consumer half of the port: what every adapter does per delivery (dedup, run, record, settle). */
function createHarness(options: { broker: FakeBroker; engine: Engine; flowId: string; idempotency?: MessageIdempotency; ttlMs?: number; stopSignal?: AbortSignal }) {
  const idempotency = options.idempotency ?? memoryMessageIdempotency();
  const ttlMs = options.ttlMs ?? 0;
  let runs = 0;
  return {
    runs: () => runs,
    handler: async (delivery: QueueMessage): Promise<MessageDisposition> => {
      if (ttlMs > 0 && (await idempotency.seen(delivery.id))) return { action: "acknowledge" }; // duplicate: no run
      runs++;
      const result = await options.engine.run(options.flowId, messageToInput(delivery), { signal: options.stopSignal });
      const outcome = runResultToOutcome(result, options.stopSignal);
      if (outcome.ok && ttlMs > 0) await idempotency.record(delivery.id, ttlMs);
      return dispositionFor(outcome, delivery, options.broker.policy);
    },
  };
}

describe("message to flow input", () => {
  it("maps a JSON object body to the input itself, and everything else to a payload string", () => {
    expect(messageToInput(message({ body: { order: 7 } }))).toEqual({ order: 7 });
    expect(messageToInput(message({ body: [1, 2] }))).toEqual({ payload: '{"order":7}' });
    expect(messageToInput(message({ body: undefined }))).toEqual({ payload: '{"order":7}' });
    expect(messageToInput(message({ body: "lamp", payload: encoder.encode("lamp") }))).toEqual({ payload: "lamp" });
  });
});

describe("run result to outcome", () => {
  const engine = makeEngine();
  const schema = { type: "object", properties: { order: { type: "number" } }, required: ["order"] };
  const strict = createEngine({ registry, flows: [{ id: "strict", input: schema, nodes: [{ id: "a", type: "ok" }], edges: [] }] });
  if (!strict.ok) throw new Error(strict.error);

  it("maps a successful run to an acknowledge outcome carrying the run id", async () => {
    const result = await engine.run("ok", {});
    expect(runResultToOutcome(result)).toEqual({ ok: true, runId: result.ok ? result.value.runId : "" });
  });

  it("maps a flow that ran and failed to a transient outcome carrying the node error", async () => {
    expect(runResultToOutcome(await engine.run("fail", {}))).toEqual({ ok: false, kind: "transient", error: "the model is unavailable" });
  });

  it("maps a busy engine to a transient outcome", async () => {
    const busy = makeEngine({ maxConcurrentRuns: 1 });
    const first = busy.run("gated");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = runResultToOutcome(await busy.run("gated"));
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(outcome).toEqual({ ok: false, kind: "transient", error: TOO_MANY_RUNS });
  });

  it("maps an engine-level failure such as an unknown flow to a permanent outcome", async () => {
    expect(runResultToOutcome(await engine.run("unknown", {}))).toEqual({ ok: false, kind: "permanent", error: 'unknown flow "unknown"' });
  });

  it("maps input that does not match the declared schema to a permanent outcome", async () => {
    const outcome = runResultToOutcome(await strict.value.run("strict", { order: "lamp" }));
    expect(outcome).toMatchObject({ ok: false, kind: "permanent" });
    expect(outcome.ok === false && outcome.error).toContain("invalid input");
  });

  it("maps a run that failed while the consumer was stopping to an aborted outcome", async () => {
    const stopSignal = AbortSignal.abort();
    const outcome = runResultToOutcome(await engine.run("hang", {}, { signal: stopSignal }), stopSignal);
    expect(outcome).toEqual({ ok: false, kind: "aborted", error: "the run was aborted while the consumer stopped" });
  });
});

describe("settlements", () => {
  const policy: QueueRetryPolicy = { attempts: 3, backoffMs: 100, multiplier: 2, maxBackoffMs: 500 };

  it("acknowledges a message whose flow succeeded, on its only delivery", async () => {
    const broker = new FakeBroker(policy);
    const harness = createHarness({ broker, engine: makeEngine(), flowId: "ok" });
    await broker.consume(message(), harness.handler);
    expect(broker.settlements).toEqual([{ id: "orders/0/1", action: "acknowledge" }]);
    expect(broker.retries).toEqual([]);
    expect(broker.deliveries).toBe(1);
    expect(harness.runs()).toBe(1);
  });

  it("retries a transient failure with backoff until the flow recovers", async () => {
    const broker = new FakeBroker(policy);
    const flaky = defaultRegistry().registerNode("flaky", { run: async () => (broker.deliveries < 2 ? { success: false, error: "the model is overloaded" } : { success: true }) });
    const built = createEngine({ registry: flaky, flows: [{ id: "flaky", nodes: [{ id: "a", type: "flaky" }], edges: [] }] });
    if (!built.ok) throw new Error(built.error);
    const harness = createHarness({ broker, engine: built.value, flowId: "flaky" });
    await broker.consume(message(), harness.handler);
    expect(broker.settlements).toEqual([{ id: "orders/0/1", action: "acknowledge" }]);
    expect(broker.retries).toEqual([{ id: "orders/0/1", delayMs: 100, deliveryCount: 1 }]); // backoffMs before the first redelivery
    expect(broker.deliveries).toBe(2);
    expect(harness.runs()).toBe(2);
  });

  it("rejects a message once its deliveries ran out", async () => {
    const broker = new FakeBroker({ attempts: 2, backoffMs: 100 });
    const harness = createHarness({ broker, engine: makeEngine(), flowId: "fail" });
    await broker.consume(message(), harness.handler);
    expect(broker.settlements).toEqual([{ id: "orders/0/1", action: "reject" }]);
    expect(broker.retries).toEqual([{ id: "orders/0/1", delayMs: 100, deliveryCount: 1 }]); // one redelivery, then the cap
    expect(broker.deliveries).toBe(2);
  });

  it("rejects a permanent failure on its first delivery, without a retry", async () => {
    const broker = new FakeBroker(policy);
    const harness = createHarness({ broker, engine: makeEngine(), flowId: "unknown" });
    await broker.consume(message(), harness.handler);
    expect(broker.settlements).toEqual([{ id: "orders/0/1", action: "reject" }]);
    expect(broker.retries).toEqual([]);
  });

  it("settles an aborted run as a retry even when the attempts have run out, so a stop never loses a message", async () => {
    const stopSignal = AbortSignal.abort();
    const broker = new FakeBroker({ attempts: 1 }); // attempts: 1 would reject any other transient failure
    const harness = createHarness({ broker, engine: makeEngine({ timeoutMs: 5 }), flowId: "hang", stopSignal });
    await broker.consume(message(), harness.handler);
    expect(broker.settlements).toEqual([]); // never acknowledged, never dead-lettered
    expect(broker.retries).toEqual([{ id: "orders/0/1", delayMs: 0, deliveryCount: 1 }]); // aborted: retry, never reject
  });

  it("settles a run that only timed out (the consumer was not stopping) as transient, respecting the cap", async () => {
    const broker = new FakeBroker({ attempts: 1 });
    const harness = createHarness({ broker, engine: makeEngine({ timeoutMs: 5 }), flowId: "hang" });
    await broker.consume(message(), harness.handler);
    expect(broker.settlements).toEqual([{ id: "orders/0/1", action: "reject" }]);
    expect(broker.retries).toEqual([]);
  });
});

describe("idempotency", () => {
  const policy: QueueRetryPolicy = { attempts: 3 };

  it("acknowledges a redelivered message without running its flow again", async () => {
    const broker = new FakeBroker(policy);
    const harness = createHarness({ broker, engine: makeEngine(), flowId: "ok", idempotency: memoryMessageIdempotency(), ttlMs: 60_000 });
    await broker.consume(message(), harness.handler);
    await broker.consume(message({ deliveryCount: 2 }), harness.handler); // the broker redelivered
    expect(broker.settlements).toEqual([
      { id: "orders/0/1", action: "acknowledge" },
      { id: "orders/0/1", action: "acknowledge" },
    ]);
    expect(harness.runs()).toBe(1); // the duplicate was acknowledged without a run
  });

  it("re-runs a message whose first run was not recorded, so recording after success never loses work", async () => {
    const broker = new FakeBroker(policy);
    const first = createHarness({ broker, engine: makeEngine(), flowId: "ok", idempotency: memoryMessageIdempotency(), ttlMs: 60_000 });
    await broker.consume(message(), first.handler);
    // A restart with an empty dedup memory: the id was never recorded, so the message runs again.
    const afterRestart = createHarness({ broker, engine: makeEngine(), flowId: "ok", idempotency: memoryMessageIdempotency(), ttlMs: 60_000 });
    await broker.consume(message({ deliveryCount: 2 }), afterRestart.handler);
    expect(first.runs() + afterRestart.runs()).toBe(2); // at-least-once: the work runs again, it is never skipped
  });

  it("expires recorded ids after their ttl", async () => {
    const idempotency = memoryMessageIdempotency();
    await idempotency.record("orders/0/1", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await idempotency.seen("orders/0/1")).toBe(false);
  });

  it("bounds the memory to the configured capacity, evicting the oldest id first", async () => {
    const idempotency = memoryMessageIdempotency(2);
    await idempotency.record("first", 60_000);
    await idempotency.record("second", 60_000);
    await idempotency.record("third", 60_000);
    expect(await idempotency.seen("first")).toBe(false);
    expect(await idempotency.seen("second")).toBe(true);
    expect(await idempotency.seen("third")).toBe(true);
  });
});

describe("redelivery delay", () => {
  it("grows the delay by the multiplier and caps it", () => {
    const policy: QueueRetryPolicy = { attempts: 10, backoffMs: 100, multiplier: 3, maxBackoffMs: 1000 };
    expect(retryDelayFor(message({ deliveryCount: 1 }), policy)).toBe(100);
    expect(retryDelayFor(message({ deliveryCount: 2 }), policy)).toBe(300);
    expect(retryDelayFor(message({ deliveryCount: 4 }), policy)).toBe(1000); // 2700, capped
  });

  it("returns zero delay when no backoff is configured", () => {
    expect(retryDelayFor(message({ deliveryCount: 1 }), { attempts: 3 })).toBe(0);
  });

  it("adds a deterministic jitter inside its bounds, the same for the same message", () => {
    const policy: QueueRetryPolicy = { attempts: 10, backoffMs: 100, jitterMs: 20 };
    for (let index = 0; index < 20; index++) {
      const delivery = message({ id: `orders/0/${index}`, deliveryCount: 1 });
      const delay = retryDelayFor(delivery, policy);
      expect(delay).toBeGreaterThanOrEqual(80);
      expect(delay).toBeLessThanOrEqual(120);
      expect(retryDelayFor(delivery, policy)).toBe(delay);
    }
  });
});
