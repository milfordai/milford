import type { BrokerClient, BrokerConsumer, BrokerMessage, BrokerOffset, BrokerProducer, EachMessage } from "../src/broker.js";

/** A message as it sits in the broker's log. */
export type FakeRecord = {
  topic: string;
  partition: number;
  offset: number;
  key?: Buffer;
  value?: Buffer;
  headers?: Record<string, string | Buffer>;
  timestampMs?: number;
};

type PartitionState = { topic: string; partition: number; messages: FakeRecord[]; nextIndex: number; busy: boolean; paused: boolean };

/**
 * An in-memory broker that implements the narrow client surface the consumer drives: lanes deliver
 * messages (in order per partition, in parallel across partitions), honoring pause, seek and commits.
 * No kafkajs, no network. The public fields are the assertions tests read.
 */
export class FakeBroker implements BrokerClient {
  readonly log: string[] = [];
  readonly committed = new Map<string, string>(); // "topic/partition" -> resume-from offset
  readonly produced: { topic: string; key?: Buffer; value?: Buffer; headers: Record<string, string | Buffer> }[] = [];
  readonly states = new Map<string, PartitionState>();
  eachMessage?: (payload: EachMessage) => Promise<void>;
  stopped = false;
  lastSeek?: BrokerOffset;
  connectFailures = 0;
  produceFailures = 0;
  private lanes: Promise<void>[] = [];
  private theConsumer?: FakeBrokerConsumer;
  private theProducer?: FakeBrokerProducer;

  /** Loads messages into the log; each is delivered in offset order within its partition. */
  add(...records: FakeRecord[]): void {
    for (const record of records) {
      const state = this.state(record.topic, record.partition);
      state.messages.push(record);
      state.messages.sort((first, second) => first.offset - second.offset);
    }
  }

  /** Makes the next `connect` fail, to test start failures. */
  failNextConnect(): void {
    this.connectFailures++;
  }

  /** Makes the next `send` fail, to test what keeps a rejected message. */
  failNextProduce(): void {
    this.produceFailures++;
  }

  consumer(_options: { groupId: string }): FakeBrokerConsumer {
    return (this.theConsumer ??= new FakeBrokerConsumer(this));
  }

  producer(): FakeBrokerProducer {
    return (this.theProducer ??= new FakeBrokerProducer(this));
  }

  state(topic: string, partition: number): PartitionState {
    const key = `${topic}/${partition}`;
    let state = this.states.get(key);
    if (!state) {
      state = { topic, partition, messages: [], nextIndex: 0, busy: false, paused: false };
      this.states.set(key, state);
    }
    return state;
  }

  /** Registers a running delivery lane; a lane crash fails the test through assertions, not an unhandled rejection. */
  laneStarted(lane: Promise<void>): void {
    this.lanes.push(lane);
    void lane.catch(() => {});
  }

  /** Resolves when every delivery lane has stopped. */
  async lanesSettled(): Promise<void> {
    await Promise.allSettled(this.lanes);
  }
}

class FakeBrokerConsumer implements BrokerConsumer {
  constructor(private broker: FakeBroker) {}

  async connect(): Promise<void> {
    if (this.broker.connectFailures > 0) {
      this.broker.connectFailures--;
      throw new Error("connect rejected by the fake broker");
    }
    this.broker.log.push("connect");
  }

  async subscribe({ topics }: { topics: string[] }): Promise<void> {
    this.broker.log.push(`subscribe:${topics.join(",")}`);
  }

  async run(options: { partitionsConsumedConcurrently?: number; eachMessage: (payload: EachMessage) => Promise<void> }): Promise<void> {
    this.broker.log.push("run");
    this.broker.eachMessage = options.eachMessage;
    const lanes = Math.max(1, options.partitionsConsumedConcurrently ?? 1);
    for (let index = 0; index < lanes; index++) this.lane();
  }

  async commitOffsets(offsets: BrokerOffset[]): Promise<void> {
    for (const { topic, partition, offset } of offsets) {
      this.broker.committed.set(`${topic}/${partition}`, offset);
      this.broker.log.push(`commit:${topic}/${partition}@${offset}`);
    }
  }

  seek({ topic, partition, offset }: BrokerOffset): void {
    const state = this.broker.state(topic, partition);
    const index = state.messages.findIndex((message) => String(message.offset) === offset);
    if (index >= 0) state.nextIndex = index;
    this.broker.lastSeek = { topic, partition, offset };
    this.broker.log.push(`seek:${topic}/${partition}@${offset}`);
  }

  pause(partitions: { topic: string; partitions?: number[] }[]): void {
    for (const target of partitions)
      for (const partition of target.partitions ?? this.allPartitions(target.topic)) {
        this.broker.state(target.topic, partition).paused = true;
        this.broker.log.push(`pause:${target.topic}/${partition}`);
      }
  }

  resume(partitions: { topic: string; partitions?: number[] }[]): void {
    for (const target of partitions)
      for (const partition of target.partitions ?? this.allPartitions(target.topic)) {
        this.broker.state(target.topic, partition).paused = false;
        this.broker.log.push(`resume:${target.topic}/${partition}`);
      }
  }

  /** Partitions of a topic that have messages loaded; a pause/resume without explicit partitions covers all of them. */
  private allPartitions(topic: string): number[] {
    return [...this.broker.states.values()].filter((state) => state.topic === topic).map((state) => state.partition);
  }

  async stop(): Promise<void> {
    this.broker.log.push("stop");
    this.broker.stopped = true;
    await this.broker.lanesSettled();
  }

  async disconnect(): Promise<void> {
    this.broker.log.push("disconnect");
  }

  /** One delivery lane: picks the next deliverable partition, calls the handler, advances past the message unless a retry seeked back to it. */
  private lane(): void {
    this.broker.laneStarted(this.loop());
  }

  private async loop(): Promise<void> {
    while (!this.broker.stopped) {
      const target = this.pick();
      if (!target) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      const { state, record } = target;
      state.busy = true;
      try {
        await this.broker.eachMessage!({ topic: state.topic, partition: state.partition, message: toBrokerMessage(record) });
      } finally {
        state.busy = false;
        // A retry seeked back to this same offset during the handler: do not advance past it.
        const seek = this.broker.lastSeek;
        const seekedBack = seek?.topic === state.topic && seek.partition === state.partition && seek.offset === String(record.offset);
        if (!seekedBack) state.nextIndex++;
        this.broker.lastSeek = undefined;
      }
    }
  }

  /** The first partition that is deliverable: not paused, not busy, with a message at its cursor. */
  private pick(): { state: PartitionState; record: FakeRecord } | undefined {
    for (const state of this.broker.states.values()) {
      if (state.paused || state.busy) continue;
      const record = state.messages[state.nextIndex];
      if (record) return { state, record };
    }
    return undefined;
  }
}

class FakeBrokerProducer implements BrokerProducer {
  constructor(private broker: FakeBroker) {}

  async connect(): Promise<void> {
    this.broker.log.push("producer:connect");
  }

  async send(batch: { topic: string; messages: { key?: Buffer; value?: Buffer; headers?: Record<string, string | Buffer> }[] }): Promise<unknown> {
    if (this.broker.produceFailures > 0) {
      this.broker.produceFailures--;
      this.broker.log.push("produce:failed");
      throw new Error("the produce was rejected by the fake broker");
    }
    for (const message of batch.messages) this.broker.produced.push({ topic: batch.topic, key: message.key, value: message.value, headers: message.headers ?? {} });
    this.broker.log.push(`produce:${batch.topic}`);
    return [];
  }

  async disconnect(): Promise<void> {
    this.broker.log.push("producer:disconnect");
  }
}

const toBrokerMessage = (record: FakeRecord): BrokerMessage => ({
  key: record.key,
  value: record.value,
  headers: record.headers,
  timestamp: record.timestampMs === undefined ? undefined : String(record.timestampMs),
  offset: String(record.offset),
});

/** Waits until `predicate` holds; throws with `description` when it never does within `timeoutMs`. */
export async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
