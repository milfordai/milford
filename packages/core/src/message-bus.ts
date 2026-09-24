import { TOO_MANY_RUNS, type Engine } from "./engine.js";
import type { Result, RunResult } from "./types.js";

// --- Message bus port (inbound: broker → flow) ------------------------------
//
// A queue adapter receives a message from a broker, runs the configured flow with the message as input,
// and settles the message with the broker according to how the run went. This port is everything the two
// sides share: the normalized message, the three settlements (acknowledge, retry, reject), the mapping
// rules from messages to flow input and from run results to settlements, and the lifecycle a host drives.
// Nothing here performs I/O: the adapter owns the broker client, the host owns the engine.
//
// Delivery is at-least-once. A message is acknowledged only after its flow finished, so a crash between
// receive and acknowledge means redelivery. Duplicates are therefore normal: a flow is either idempotent,
// or its consumer deduplicates on `QueueMessage.id` through `MessageIdempotency`.
//
// Ordering. Brokers keep messages in order per ordering unit (a queue and key, or a queue and partition).
// An adapter preserves that order within a unit: the next message of a unit is consumed only after the
// current one settled. The `concurrency` limit runs several units in parallel, never two messages of the
// same unit.
//
// Backpressure. A consumer holds at most `maxInFlight` received-but-unsettled messages. When the limit is
// reached it stops receiving until messages settle, so a slow flow slows the consumer down instead of
// filling memory.
//
// Cancellation and shutdown. The flow run of a message runs with a signal that aborts when the consumer
// stops. An aborted run is never acknowledged and never counts against the retry attempts: it settles as
// a retry, so a stop can neither lose a message nor dead-letter one that simply got cancelled.

/** A message a queue adapter received from a broker and normalized. */
export type QueueMessage = {
  /**
   * Identity of this delivery: the broker's message id when it provides one, otherwise an adapter-computed
   * key made of the queue, the ordering unit and the position. A producer can stamp its own logical id in a
   * message attribute (convention: `id`) when delivery identity is not enough; consumers can use it for
   * stronger deduplication.
   */
  id: string;
  /** Queue the message came from, named as the broker names it. */
  queue: string;
  /** Payload exactly as delivered. */
  payload: Uint8Array;
  /** Parsed JSON body when the payload is valid JSON, `undefined` otherwise. */
  body?: unknown;
  /** Broker metadata normalized to strings, such as a content type or a producer-stamped message id. */
  attributes?: Record<string, string>;
  /** Ordering key: the broker keeps same-key messages in order. */
  key?: string;
  /** Broker receive time in milliseconds since the epoch, when known. */
  timestampMs?: number;
  /** Which delivery this is, starting at 1 and growing on redelivery. Brokers without delivery counts are tracked by the adapter. */
  deliveryCount: number;
};

/** How a consumer settles a message with its broker after the flow ran. */
export type MessageDisposition =
  /** Processed: the broker may forget the message. */
  | { action: "acknowledge" }
  /** Not processed yet: redeliver, after `delayMs` when the broker can delay a redelivery. */
  | { action: "retry"; delayMs?: number }
  /**
   * Not processed and never redelivered: the adapter moves the message to its configured dead-letter
   * destination when it has one, otherwise drops it after logging. An adapter that cannot dead-letter and
   * cannot drop (for example because its dead-letter destination is down) retries instead, so a reject can
   * never lose a message.
   */
  | { action: "reject" };

/** What the flow run decided about a message; `dispositionFor` turns it into a settlement. */
export type QueueRunOutcome =
  | { ok: true; runId: string }
  | {
      ok: false;
      /** `transient` redelivers per the retry policy; `permanent` rejects (dead-letter or drop); `aborted` always retries. */
      kind: "transient" | "permanent" | "aborted";
      error: string;
    };

/** Consumer-level redelivery policy. Mirrors the node-level `RetryPolicy` vocabulary. */
export type QueueRetryPolicy = {
  /** Deliveries of one message, including the first, before it is rejected instead of retried. */
  attempts: number;
  /** Delay before the first redelivery; grows by `multiplier` each redelivery, capped at `maxBackoffMs`. */
  backoffMs?: number;
  /** Growth per redelivery; defaults to 2. */
  multiplier?: number;
  /** Cap on each redelivery delay. */
  maxBackoffMs?: number;
  /** Random plus/minus added to each delay, to scatter redeliveries. */
  jitterMs?: number;
};

/** Throughput and backpressure limits of a consumer. */
export type ConsumeLimits = {
  /**
   * Messages whose flow runs at once. Order within an ordering unit is preserved whatever this is; the
   * limit runs several units in parallel. Default 1.
   */
  concurrency?: number;
  /**
   * Messages received from the broker but not yet settled, held by the consumer at once. When the limit is
   * reached the consumer stops receiving until messages settle (backpressure). Defaults to `concurrency`.
   */
  maxInFlight?: number;
};

/**
 * Remembers processed message ids, so a redelivered message can be acknowledged without running its flow
 * again. Any storage can implement it. Recording happens after a successful run, never before: a crash
 * between run and record costs one extra run, while recording before the run could let the message be
 * acknowledged without ever finishing. Overlapping deliveries of the same id may therefore both run;
 * flows must tolerate it.
 */
export interface MessageIdempotency {
  /** Reports whether `id` was recorded and is still remembered; does not record it. */
  seen(id: string): Promise<boolean>;
  /** Records `id` as processed for the next `ttlMs` milliseconds. */
  record(id: string, ttlMs: number): Promise<void>;
}

/** In-memory `MessageIdempotency`: a bounded first-in-first-out map of ids with expiries. */
export function memoryMessageIdempotency(capacity = 10_000): MessageIdempotency {
  const expiresAt = new Map<string, number>();
  return {
    async seen(id) {
      const expiry = expiresAt.get(id);
      if (expiry === undefined) return false;
      if (expiry > Date.now()) return true;
      expiresAt.delete(id);
      return false;
    },
    async record(id, ttlMs) {
      expiresAt.set(id, Date.now() + ttlMs);
      while (expiresAt.size > capacity) {
        const oldest = expiresAt.keys().next().value;
        if (oldest === undefined) break;
        expiresAt.delete(oldest);
      }
    },
  };
}

/** A running queue consumer of one configured queue group, driven by its host. */
export interface QueueConsumer {
  /** Configured id; unique across all consumers of a host. */
  id: string;
  /** Adapter type (registry key); consumers of one type are built by the same adapter package. */
  type: string;
  /**
   * Connects and starts consuming. Resolves once messages flow; connection failures resolve to
   * `{ ok: false, error }` instead of throwing. A second call is a no-op.
   */
  start(): Promise<Result<void>>;
  /**
   * Stops receiving, aborts the in-flight flow runs (their messages are settled as retries and so
   * redelivered after the next start), and disconnects. Never rejects; a second call is a no-op.
   */
  stop(): Promise<void>;
}

/** What a host hands every queue adapter: the engine that runs the flows, a log line sink, and an optional shared dedup memory. */
export type QueueAdapterDeps = {
  engine: Engine;
  log?: (line: string) => void;
  idempotency?: MessageIdempotency;
};

/**
 * Default message → flow input mapping, shared by every adapter: a JSON object body becomes the input
 * itself; anything else (arrays, scalars, non-JSON payloads) becomes `{ payload: <decoded text> }`.
 */
export function messageToInput(message: QueueMessage): Record<string, unknown> {
  const body = message.body;
  if (body !== undefined && typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  return { payload: new TextDecoder().decode(message.payload) };
}

/**
 * Default run result → outcome mapping, shared by every adapter:
 * - a successful run is an acknowledge candidate;
 * - a busy engine is transient: redeliver, the load may have passed;
 * - a run that failed while its consumer was stopping is `aborted`: redeliver, never against the attempt
 *   cap, so a stop can neither lose a message nor dead-letter one it cancelled itself;
 * - input that does not match the flow's declared input, and any other engine-level failure, are permanent:
 *   redelivering the same message cannot change the outcome;
 * - a flow that ran and failed is transient: retries give failing infrastructure another chance, and the
 *   attempt cap turns persistent failures into rejects, so poison messages cannot loop forever.
 */
export function runResultToOutcome(result: Result<RunResult>, stopSignal?: AbortSignal): QueueRunOutcome {
  if (result.ok) {
    if (result.value.ok) return { ok: true, runId: result.value.runId };
    if (stopSignal?.aborted) return { ok: false, kind: "aborted", error: "the run was aborted while the consumer stopped" };
    const failed = Object.values(result.value.nodes).find((state) => state.status === "error");
    return { ok: false, kind: "transient", error: failed?.result?.error ?? "the flow did not complete successfully" };
  }
  if (result.error === TOO_MANY_RUNS) return { ok: false, kind: "transient", error: result.error };
  return { ok: false, kind: "permanent", error: result.error };
}

/**
 * Outcome → settlement, the rule every adapter applies: success acknowledges; a permanent failure rejects
 * (dead-letter or drop); a transient failure retries while `deliveryCount` is below `attempts` and rejects
 * once the deliveries ran out; an aborted run always retries, whatever the attempts.
 */
export function dispositionFor(outcome: QueueRunOutcome, message: QueueMessage, policy: QueueRetryPolicy): MessageDisposition {
  if (outcome.ok) return { action: "acknowledge" };
  if (outcome.kind === "aborted") return { action: "retry", delayMs: retryDelayFor(message, policy) };
  if (outcome.kind === "permanent" || message.deliveryCount >= policy.attempts) return { action: "reject" };
  return { action: "retry", delayMs: retryDelayFor(message, policy) };
}

/** Backoff before the next redelivery of `message`: `backoffMs` growing by `multiplier`, capped at `maxBackoffMs`, plus deterministic jitter. */
export function retryDelayFor(message: QueueMessage, policy: QueueRetryPolicy): number {
  const base = (policy.backoffMs ?? 0) * (policy.multiplier ?? 2) ** Math.max(0, message.deliveryCount - 1);
  const capped = Math.min(base, policy.maxBackoffMs ?? Infinity);
  if (capped <= 0 || !policy.jitterMs) return Math.max(0, capped);
  const spread = hash(`${message.id}:${message.deliveryCount}`) % (2 * policy.jitterMs + 1);
  return Math.max(0, capped + spread - policy.jitterMs);
}

/** Deterministic pseudo-random in [0, 2^32): the same input always produces the same value, so redeliveries scatter across messages without making tests flaky. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}
