import type { Engine, Result, RunResult } from "@milfordai/core";
import { describe, expect, it } from "vitest";
import { createConsumers } from "../src/index.js";
import { FakeBroker, waitFor } from "./fake-broker.js";

const succeeded = (runId = "run-1"): Result<RunResult> => ({ ok: true, value: { ok: true, runId, nodes: {} } });
const flowFailed = (error = "the model is unavailable"): Result<RunResult> => ({
  ok: true,
  value: { ok: false, runId: "run-1", nodes: { a: { status: "error", result: { success: false, error } } } },
});
const engineRejected = (error: string): Result<RunResult> => ({ ok: false, error });

/** An engine double: scripts results per run and records what the consumer passed it. */
function engineDouble(run: (input: Record<string, unknown>, signal: AbortSignal, call: number) => Promise<Result<RunResult>>) {
  const inputs: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const engine: Engine = {
    flows: () => [{ id: "process-order", nodes: 2 }],
    run: async (_flowId, input = {}, opts = {}) => {
      const signal = opts.signal ?? new AbortController().signal;
      inputs.push(input);
      signals.push(signal);
      return run(input, signal, calls++);
    },
  };
  return { engine, inputs, signals, calls: () => calls };
}

const consumerConfig = (overrides: Record<string, unknown> = {}) => ({
  id: "orders",
  type: "kafka",
  flow: "process-order",
  brokers: ["broker-1:9092"],
  topics: ["orders"],
  groupId: "milford-orders",
  retry: { attempts: 3, backoffMs: 5 },
  ...overrides,
});

/** Builds one consumer against the fake broker; a log line sink the test can read. */
function build(broker: FakeBroker, engine: Engine, lines: string[], overrides: Record<string, unknown> = {}) {
  const built = createConsumers([consumerConfig(overrides)], { engine, createClient: () => broker, log: (line) => lines.push(line) });
  if (!built.ok) throw new Error(built.error);
  return built.value[0]!;
}

describe("config validation", () => {
  const deps = { engine: engineDouble(async () => succeeded()).engine };

  it("reports a config error with the consumer id and the offending field", () => {
    const built = createConsumers([consumerConfig({ brokers: [] })], { ...deps, createClient: () => new FakeBroker() });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain('queue consumer "orders"');
    expect(built.ok === false && built.error).toContain("brokers");
  });

  it("reports an unknown flow", () => {
    const built = createConsumers([consumerConfig({ flow: "nope" })], { ...deps, createClient: () => new FakeBroker() });
    expect(built).toEqual({ ok: false, error: 'queue consumer "orders": unknown flow "nope"' });
  });

  it("reports duplicate consumer ids", () => {
    const built = createConsumers([consumerConfig(), consumerConfig({ topics: ["other"] })], { ...deps, createClient: () => new FakeBroker() });
    expect(built).toEqual({ ok: false, error: 'duplicate queue consumer id "orders"' });
  });

  it("rejects configs of another type", () => {
    const built = createConsumers([consumerConfig({ type: "mqtt" })], { ...deps, createClient: () => new FakeBroker() });
    expect(built.ok).toBe(false);
  });
});

describe("kafka consumer", () => {
  it("acknowledges a successful run: commits the resume-from offset, never dead-letters", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => succeeded());
    const consumer = build(broker, engine.engine, lines);
    broker.add({ topic: "orders", partition: 0, offset: 41, value: Buffer.from('{"order": 7}') });

    expect(await consumer.start()).toEqual({ ok: true, value: undefined });
    await waitFor(() => broker.committed.get("orders/0") === "42", "the resume-from offset to be committed");
    expect(engine.calls()).toBe(1);
    expect(engine.inputs[0]).toEqual({ order: 7 }); // a JSON object body becomes the flow input
    expect(broker.produced).toEqual([]);
    await consumer.stop();
  });

  it("acknowledges a duplicate delivery without running its flow again", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => succeeded());
    const consumer = build(broker, engine.engine, lines);
    broker.add({ topic: "orders", partition: 0, offset: 10, headers: { id: "order-7" }, value: Buffer.from('{"order": 7}') });
    broker.add({ topic: "orders", partition: 0, offset: 11, headers: { id: "order-7" }, value: Buffer.from('{"order": 7}') });

    await consumer.start();
    await waitFor(() => broker.committed.get("orders/0") === "12", "both deliveries to be acknowledged");
    expect(engine.calls()).toBe(1); // the duplicate ran no flow
    expect(lines.some((line) => line.includes("duplicate delivery acknowledged without a run"))).toBe(true);
    await consumer.stop();
  });

  it("retries a retryable failure: seeks back, pauses, resumes, and commits once the flow recovers", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async (_input, _signal, call) => (call === 0 ? flowFailed("the model is overloaded") : succeeded("run-2")));
    const consumer = build(broker, engine.engine, lines);
    broker.add({ topic: "orders", partition: 0, offset: 1, value: Buffer.from('{"order": 7}') });

    await consumer.start();
    await waitFor(() => broker.committed.get("orders/0") === "2", "the recovered message to be committed");
    expect(engine.calls()).toBe(2);
    expect(engine.inputs).toEqual([{ order: 7 }, { order: 7 }]); // the same message, run twice
    expect(broker.log).toContain("seek:orders/0@1");
    expect(broker.log).toContain("pause:orders/0");
    expect(broker.log).toContain("resume:orders/0");
    await consumer.stop();
  });

  it("rejects a permanent failure on its first delivery and dead-letters it", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => engineRejected("invalid input: order must be a number"));
    const consumer = build(broker, engine.engine, lines, { deadLetterTopic: "orders.dlq" });
    broker.add({ topic: "orders", partition: 0, offset: 5, value: Buffer.from("not json") });

    await consumer.start();
    await waitFor(() => broker.committed.get("orders/0") === "6", "the rejected message to be committed past");
    expect(engine.calls()).toBe(1); // a permanent failure is never redelivered
    expect(broker.produced).toHaveLength(1);
    expect(broker.produced[0]!.topic).toBe("orders.dlq");
    expect(broker.produced[0]!.value?.toString()).toBe("not json"); // the raw payload, unchanged
    expect(broker.produced[0]!.headers["x-milford-original-topic"]).toBe("orders");
    expect(broker.produced[0]!.headers["x-milford-original-offset"]).toBe("5");
    expect(broker.produced[0]!.headers["x-milford-error"]).toContain("invalid input");
    await consumer.stop();
  });

  it("drops a rejected message when no dead-letter topic is configured", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => engineRejected("invalid input: order must be a number"));
    const consumer = build(broker, engine.engine, lines);
    broker.add({ topic: "orders", partition: 0, offset: 5, value: Buffer.from("not json") });

    await consumer.start();
    await waitFor(() => broker.committed.get("orders/0") === "6", "the dropped message to be committed past");
    expect(broker.produced).toEqual([]);
    expect(lines.some((line) => line.includes("no dead-letter topic is configured; the rejected message is dropped"))).toBe(true);
    await consumer.stop();
  });

  it("dead-letters a message whose deliveries ran out", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => flowFailed("the model is unavailable"));
    const consumer = build(broker, engine.engine, lines, { retry: { attempts: 2, backoffMs: 5 }, deadLetterTopic: "orders.dlq" });
    broker.add({ topic: "orders", partition: 0, offset: 9, value: Buffer.from("{}") });

    await consumer.start();
    await waitFor(() => broker.committed.get("orders/0") === "10", "the capped message to be settled");
    expect(engine.calls()).toBe(2); // delivered twice: once plus one redelivery
    expect(broker.log.filter((line) => line.startsWith("seek:"))).toHaveLength(1);
    expect(broker.produced).toHaveLength(1);
    expect(broker.produced[0]!.headers["x-milford-delivery-count"]).toBe("2");
    await consumer.stop();
  });

  it("keeps a rejected message for redelivery when the dead-letter produce fails", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => engineRejected("invalid input: order must be a number"));
    const consumer = build(broker, engine.engine, lines, { deadLetterTopic: "orders.dlq" });
    broker.failNextProduce();
    broker.add({ topic: "orders", partition: 0, offset: 3, value: Buffer.from("{}") });

    await consumer.start();
    await waitFor(() => broker.committed.get("orders/0") === "4", "the message to settle once the dead-letter produce succeeds");
    expect(engine.calls()).toBe(2); // the whole cycle ran once more, rather than dropping the message
    expect(broker.log).toContain("produce:failed");
    expect(broker.produced).toHaveLength(1);
    await consumer.stop();
  });

  it("stops cleanly: aborts the in-flight run, leaves it uncommitted for redelivery, disconnects", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(
      (_input, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(flowFailed("aborted")))), // runs until the consumer stops
    );
    const consumer = build(broker, engine.engine, lines);
    broker.add({ topic: "orders", partition: 0, offset: 7, value: Buffer.from("{}") });

    await consumer.start();
    await waitFor(() => engine.calls() === 1, "the run to start");
    await consumer.stop(); // resolves: the abort settles the run, the consumer disconnects

    expect(broker.committed.size).toBe(0); // never acknowledged: redelivered after the next start
    expect(broker.log).toContain("pause:orders/0"); // settled as a retry, not as a drop
    expect(broker.log).toContain("stop");
    expect(broker.log).toContain("disconnect");
    await new Promise((resolve) => setTimeout(resolve, 20)); // a paused partition never resumes after stop
    expect(engine.calls()).toBe(1);
  });

  it("runs partitions in parallel up to the configured concurrency, committing each resume-from offset", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = engineDouble(async (_input, _signal, call) => gate.then(() => succeeded(`run-${call}`)));
    const consumer = build(broker, engine.engine, lines, { concurrency: 2, retry: { attempts: 1 } });
    broker.add({ topic: "orders", partition: 0, offset: 1, value: Buffer.from("{}") });
    broker.add({ topic: "orders", partition: 1, offset: 1, value: Buffer.from("{}") });

    await consumer.start();
    await waitFor(() => engine.calls() === 2, "both partitions to run at once"); // neither has resolved yet: truly parallel
    release();
    await waitFor(() => broker.committed.get("orders/0") === "2" && broker.committed.get("orders/1") === "2", "both offsets to be committed");
    await consumer.stop();
  });

  it("reports a start failure instead of throwing", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    const engine = engineDouble(async () => succeeded());
    const consumer = build(broker, engine.engine, lines);
    broker.failNextConnect();

    const started = await consumer.start();
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error).toContain('queue consumer "orders" cannot start');
    expect(started.ok === false && started.error).toContain("connect rejected by the fake broker");
  });

  it("limits in-flight messages with maxInFlight, even when concurrency would allow more", async () => {
    const broker = new FakeBroker();
    const lines: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = engineDouble(async (_input, _signal, call) => gate.then(() => succeeded(`run-${call}`)));
    const consumer = build(broker, engine.engine, lines, { concurrency: 2, maxInFlight: 1, retry: { attempts: 1 } });
    broker.add({ topic: "orders", partition: 0, offset: 1, value: Buffer.from("{}") });
    broker.add({ topic: "orders", partition: 1, offset: 1, value: Buffer.from("{}") });

    await consumer.start();
    await waitFor(() => engine.calls() === 1, "only one partition to start while the first is in flight");
    expect(engine.calls()).toBe(1); // the second message is held by the maxInFlight semaphore
    release();
    await waitFor(() => broker.committed.get("orders/0") === "2" && broker.committed.get("orders/1") === "2", "both offsets to be committed");
    await consumer.stop();
  });
});
