import {
  dispositionFor,
  memoryMessageIdempotency,
  messageToInput,
  retryDelayFor,
  runResultToOutcome,
  type MessageDisposition,
  type MessageIdempotency,
  type QueueAdapterDeps,
  type QueueConsumer,
  type QueueMessage,
  type QueueRunOutcome,
  type Result,
} from "@milfordai/core";
import { kafkaConsumerConfigSchema, type KafkaConsumerConfig } from "./config.js";
import { createBrokerClient, type BrokerClient, type BrokerConfig, type BrokerMessage, type EachMessage } from "./broker.js";

export type KafkaQueueDeps = QueueAdapterDeps & {
  /** Broker client factory; kafkajs by default. Tests inject a fake. */
  createClient?: (config: BrokerConfig) => BrokerClient;
};

type FailedOutcome = Extract<QueueRunOutcome, { ok: false }>;

type SettleContext = {
  topic: string;
  partition: number;
  message: BrokerMessage;
  queueMessage: QueueMessage;
  deliveryKey: string;
  outcome?: FailedOutcome;
};

/** Validates consumer configs and builds one consumer per config. Fails on unknown flows, duplicate ids and invalid settings. */
export function createConsumers(configs: unknown[], deps: KafkaQueueDeps): Result<QueueConsumer[]> {
  const flows = new Set(deps.engine.flows().map((flow) => flow.id));
  const consumers: QueueConsumer[] = [];
  for (const raw of configs) {
    const id = (raw as { id?: string })?.id ?? "?";
    const parsed = kafkaConsumerConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `queue consumer "${id}": ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}` };
    }
    const config = parsed.data;
    if (consumers.some((existing) => existing.id === config.id)) return { ok: false, error: `duplicate queue consumer id "${config.id}"` };
    if (!flows.has(config.flow)) return { ok: false, error: `queue consumer "${config.id}": unknown flow "${config.flow}"` };
    consumers.push(createConsumer(config, deps));
  }
  return { ok: true, value: consumers };
}

/** One consumer: subscribes, runs the flow per message, and settles every message per the port semantics. */
function createConsumer(config: KafkaConsumerConfig, deps: KafkaQueueDeps): QueueConsumer {
  const log = deps.log ?? console.log;
  const client = (deps.createClient ?? createBrokerClient)({ brokers: config.brokers, clientId: config.clientId, ssl: config.ssl, sasl: config.sasl });
  const consumer = client.consumer({ groupId: config.groupId });
  const deadLetterProducer = config.deadLetterTopic ? client.producer() : undefined;
  const stopSignal = new AbortController();
  const deliveryCounts = new Map<string, number>();
  const pendingResumes = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();
  const idempotency = deps.idempotency ?? memoryMessageIdempotency();
  const maxInFlight = config.maxInFlight ?? config.concurrency;
  let activeInFlight = 0;
  const slotWaiters: Array<{ resolve: () => void; reject: () => void; signal: AbortSignal; onAbort: () => void }> = [];

  const releaseSlot = (): void => {
    activeInFlight--;
    const index = slotWaiters.findIndex((waiter) => !waiter.signal.aborted);
    if (index >= 0) {
      const next = slotWaiters.splice(index, 1)[0]!;
      next.signal.removeEventListener("abort", next.onAbort);
      activeInFlight++;
      next.resolve();
    }
  };

  const acquireSlot = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (activeInFlight < maxInFlight) {
      activeInFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = slotWaiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) slotWaiters.splice(index, 1);
        reject(signal.reason);
      };
      slotWaiters.push({ resolve, reject, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const logLine = (level: "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}) =>
    log(JSON.stringify({ level, msg: message, consumer: config.id, ...extra }));

  /** Commits the offset after `message`, so the message is never redelivered to this group. */
  const commit = async (topic: string, partition: number, offset: string): Promise<void> => {
    try {
      await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
    } catch (error) {
      logLine("error", "commit failed; the settled message is redelivered after a restart", { topic, offset, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const scheduleResume = (topic: string, partition: number, delayMs: number) => {
    const partitionKey = `${topic}/${partition}`;
    const existing = pendingResumes.get(partitionKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingResumes.delete(partitionKey);
      if (!stopSignal.signal.aborted) consumer.resume([{ topic, partitions: [partition] }]);
    }, delayMs);
    pendingResumes.set(partitionKey, timer);
  };

  /** Produces the raw message to the dead-letter topic, with headers recording where it came from and why. */
  const deadLetter = async (context: SettleContext): Promise<"sent" | "failed"> => {
    try {
      await deadLetterProducer!.send({
        topic: config.deadLetterTopic!,
        messages: [{
          key: context.message.key ?? undefined,
          value: context.message.value ?? undefined,
          headers: {
            ...context.message.headers,
            "x-milford-original-topic": context.topic,
            "x-milford-original-partition": String(context.partition),
            "x-milford-original-offset": context.message.offset,
            "x-milford-delivery-count": String(context.queueMessage.deliveryCount),
            ...(context.outcome ? { "x-milford-error": context.outcome.error.slice(0, 512) } : {}),
          },
        }],
      });
      return "sent";
    } catch (error) {
      logLine("error", "the dead-letter produce failed", { topic: config.deadLetterTopic!, error: error instanceof Error ? error.message : String(error) });
      return "failed";
    }
  };

  /** Applies the settlement to the broker; the only place that commits, seeks or dead-letters. */
  const settle = async (disposition: MessageDisposition, context: SettleContext): Promise<void> => {
    if (disposition.action === "acknowledge") {
      deliveryCounts.delete(context.deliveryKey);
      return void (await commit(context.topic, context.partition, context.message.offset));
    }
    if (disposition.action === "retry") {
      // Seek back to the message, pause its partition, resume after the backoff: redelivery without a restart.
      consumer.seek({ topic: context.topic, partition: context.partition, offset: context.message.offset });
      consumer.pause([{ topic: context.topic, partitions: [context.partition] }]);
      scheduleResume(context.topic, context.partition, disposition.delayMs ?? 0);
      return;
    }

    // Reject: dead-letter when configured, otherwise drop; a failed dead-letter produce keeps the message.
    const deadLettered = deadLetterProducer ? await deadLetter(context) : "none";
    if (deadLettered === "failed") {
      logLine("warn", "rejected, but the message is retried until its dead-letter produce succeeds", { topic: context.topic, offset: context.message.offset });
      return settle({ action: "retry", delayMs: retryDelayFor(context.queueMessage, config.retry) }, context);
    }
    if (deadLettered === "none") logLine("warn", "no dead-letter topic is configured; the rejected message is dropped", { topic: context.topic, offset: context.message.offset, deliveryCount: context.queueMessage.deliveryCount, error: context.outcome?.error });
    else logLine("error", "rejected and dead-lettered", { topic: context.topic, offset: context.message.offset, deadLetterTopic: config.deadLetterTopic, deliveryCount: context.queueMessage.deliveryCount, error: context.outcome?.error });
    deliveryCounts.delete(context.deliveryKey);
    await commit(context.topic, context.partition, context.message.offset);
  };

  const eachMessage = async ({ topic, partition, message }: EachMessage): Promise<void> => {
    try {
      await acquireSlot(stopSignal.signal);
    } catch {
      // The consumer is stopping; leave the message uncommitted so it is redelivered after the next start.
      return;
    }

    const processMessage = async (): Promise<void> => {
      const deliveryKey = `${topic}/${partition}/${message.offset}`;
      const deliveryCount = (deliveryCounts.get(deliveryKey) ?? 0) + 1;
      deliveryCounts.set(deliveryKey, deliveryCount);

      const payload = message.value ?? Buffer.alloc(0);
      const queueMessage: QueueMessage = {
        id: messageId(message, deliveryKey),
        queue: topic,
        payload,
        body: parseJson(payload),
        attributes: messageAttributes(message.headers),
        key: message.key?.toString("utf8") || undefined,
        timestampMs: message.timestamp ? Number(message.timestamp) : undefined,
        deliveryCount,
      };
      const context: SettleContext = { topic, partition, message, queueMessage, deliveryKey };

      try {
        if (config.idempotencyTtlMs > 0 && (await idempotency.seen(queueMessage.id))) {
          logLine("info", "duplicate delivery acknowledged without a run", { flow: config.flow, messageId: queueMessage.id });
          return settle({ action: "acknowledge" }, context);
        }

        const result = await deps.engine.run(config.flow, messageToInput(queueMessage), { signal: stopSignal.signal, timeoutMs: config.timeoutMs });
        const outcome = runResultToOutcome(result, stopSignal.signal);
        logLine(outcome.ok ? "info" : "error", "run", {
          flow: config.flow,
          ok: outcome.ok,
          runId: outcome.ok ? outcome.runId : undefined,
          messageId: queueMessage.id,
          deliveryCount,
          error: outcome.ok ? undefined : outcome.error,
        });
        // Record only after a successful run: a crash between run and record costs one extra run, never a lost one.
        if (outcome.ok && config.idempotencyTtlMs > 0) await idempotency.record(queueMessage.id, config.idempotencyTtlMs);

        return settle(dispositionFor(outcome, queueMessage, config.retry), { ...context, outcome: outcome.ok ? undefined : outcome });
      } catch (error) {
        // Nothing here ever throws past the message; an unsettled message is simply redelivered later.
        logLine("error", "internal error while consuming; the message is left for redelivery", { topic, offset: message.offset, error: error instanceof Error ? error.message : String(error) });
      }
    };

    try {
      await processMessage();
    } finally {
      releaseSlot();
    }
  };

  let startPromise: Promise<Result<void>> | undefined;
  let stopPromise: Promise<void> | undefined;

  async function start(): Promise<Result<void>> {
    try {
      await consumer.connect();
      if (deadLetterProducer) await deadLetterProducer.connect();
      await consumer.subscribe({ topics: config.topics });
      await consumer.run({
        autoCommit: false,
        partitionsConsumedConcurrently: config.concurrency,
        eachMessage: (payload) => {
          const work = eachMessage(payload);
          inFlight.add(work);
          void work.finally(() => inFlight.delete(work));
          return work;
        },
      });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: `queue consumer "${config.id}" cannot start: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function stop(): Promise<void> {
    stopSignal.abort(); // in-flight runs settle as retries: never acknowledged, redelivered after the next start
    for (const timer of pendingResumes.values()) clearTimeout(timer); // a stopped consumer never resumes a paused partition
    await Promise.allSettled([...inFlight]); // let the aborted runs finish settling
    try {
      await consumer.stop();
      await Promise.allSettled([...inFlight]); // a handler the broker had already dispatched settles too
      await consumer.disconnect();
      if (deadLetterProducer) await deadLetterProducer.disconnect();
    } catch (error) {
      logLine("error", "stop failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    id: config.id,
    type: "kafka",
    start: () => (startPromise ??= start()),
    stop: () => (stopPromise ??= stop()),
  };
}

const parseJson = (payload: Buffer): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
};

/** Message identity: a producer-stamped `id` header wins, otherwise the delivery position is unique and stable. */
const messageId = (message: BrokerMessage, deliveryKey: string): string => {
  const header = message.headers?.["id"];
  const id = typeof header === "string" ? header : header?.toString("utf8");
  return id || deliveryKey;
};

const messageAttributes = (headers: Record<string, string | Buffer | null> | null | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    attributes[name] = typeof value === "string" ? value : value.toString("utf8");
  }
  return attributes;
};
