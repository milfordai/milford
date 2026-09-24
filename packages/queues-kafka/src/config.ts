import { z } from "zod";

/** Redelivery policy of a queue consumer; the core `QueueRetryPolicy`, as config. */
export const queueRetrySchema = z.object({
  /** Deliveries of one message, including the first, before it is rejected (dead-lettered) instead of retried. */
  attempts: z.number().int().positive(),
  /** Delay before the first redelivery, in milliseconds. */
  backoffMs: z.number().nonnegative().optional(),
  /** Growth per redelivery; defaults to 2. */
  multiplier: z.number().positive().optional(),
  /** Cap on each redelivery delay, in milliseconds. */
  maxBackoffMs: z.number().positive().optional(),
  /** Random plus/minus added to each redelivery delay, in milliseconds. */
  jitterMs: z.number().nonnegative().optional(),
});

/** One Kafka consumer config: the `queues:` section of milford.config.yaml, validated here and built by this package. */
export const kafkaConsumerConfigSchema = z.object({
  id: z.string(),
  type: z.literal("kafka"),
  /** Flow that runs once per message. */
  flow: z.string(),
  /** Bootstrap addresses, for example ["broker-1:9092"]. */
  brokers: z.array(z.string()).min(1),
  /** Client id the broker sees. */
  clientId: z.string().default("milford"),
  /** Topics consumed. A JSON object message body becomes the flow input; anything else becomes `{ payload: <text> }`. */
  topics: z.array(z.string()).min(1),
  /** Consumer group; committed offsets and redeliveries are per group. */
  groupId: z.string().min(1),
  /** TLS on/off for the common case. */
  ssl: z.boolean().optional(),
  /** SASL credentials when the broker requires them. */
  sasl: z.object({ mechanism: z.enum(["plain", "scram-sha-256", "scram-sha-512"]), username: z.string(), password: z.string() }).optional(),
  /** Rejected messages are produced here (with headers recording where they came from and why). Unset means drop after logging. */
  deadLetterTopic: z.string().optional(),
  /** Redelivery policy; `{ attempts: 1 }` by default: one delivery, no redelivery. */
  retry: queueRetrySchema.default({ attempts: 1 }),
  /** Flow runs in parallel across topic partitions; order within a partition is always preserved. Default 1. */
  concurrency: z.number().int().positive().default(1),
  /**
   * Messages received from the broker but not yet settled, held at once. When the limit is reached the
   * consumer stops handing messages to flows until messages settle (backpressure). Defaults to `concurrency`.
   */
  maxInFlight: z.number().int().positive().optional(),
  /** Per-run timeout override in milliseconds; the engine default applies when unset. */
  timeoutMs: z.number().positive().optional(),
  /** How long a processed message id is remembered, so a redelivered message is acknowledged without another run. Default 10 minutes; 0 disables. */
  idempotencyTtlMs: z.number().int().nonnegative().default(600_000),
});

export type KafkaConsumerConfig = z.infer<typeof kafkaConsumerConfigSchema>;
