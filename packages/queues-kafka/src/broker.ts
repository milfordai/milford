import { Kafka, logLevel, type KafkaConfig } from "kafkajs";

/** The slice of a Kafka message the consumer reads. */
export type BrokerMessage = {
  key?: Buffer | null;
  value?: Buffer | null;
  headers?: Record<string, string | Buffer | null> | null;
  /** Broker receive time in milliseconds, as a string. */
  timestamp?: string;
  /** Position in the partition, as a string. */
  offset: string;
};

/** What the consumer is handed per message. */
export type EachMessage = { topic: string; partition: number; message: BrokerMessage };

export type BrokerOffset = { topic: string; partition: number; offset: string };
/** Topic partitions to pause or resume: `[{ topic, partitions: [0, 1] }]`. */
export type BrokerPartitions = { topic: string; partitions?: number[] }[];

/** SASL credentials for the three common mechanisms. */
export type BrokerSasl = { mechanism: "plain" | "scram-sha-256" | "scram-sha-512"; username: string; password: string };

/**
 * The narrow client surface the consumer drives. A structural type, so tests fake the broker without
 * kafkajs and without a running Kafka.
 */
export type BrokerConsumer = {
  connect(): Promise<void>;
  subscribe(options: { topics: string[] }): Promise<void>;
  run(options: {
    /** Offsets are committed only after a message settled, never automatically. */
    autoCommit?: boolean;
    /** Partitions processed in parallel; messages of one partition stay in order. */
    partitionsConsumedConcurrently?: number;
    eachMessage: (payload: EachMessage) => Promise<void>;
  }): Promise<void>;
  commitOffsets(offsets: BrokerOffset[]): Promise<void>;
  seek(target: BrokerOffset): void;
  pause(partitions: BrokerPartitions): void;
  resume(partitions: BrokerPartitions): void;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
};

export type BrokerProducer = {
  connect(): Promise<void>;
  send(batch: { topic: string; messages: { key?: Buffer; value?: Buffer; headers?: Record<string, string | Buffer> }[] }): Promise<unknown>;
  disconnect(): Promise<void>;
};

export type BrokerClient = {
  consumer(options: { groupId: string }): BrokerConsumer;
  producer(): BrokerProducer;
};

export type BrokerConfig = {
  brokers: string[];
  clientId: string;
  ssl?: boolean;
  sasl?: BrokerSasl;
};

/** The default client factory: kafkajs. */
export function createBrokerClient(config: BrokerConfig): BrokerClient {
  const kafka = new Kafka({
    brokers: config.brokers,
    clientId: config.clientId,
    ssl: config.ssl,
    // kafkajs types SASL as one object shape per mechanism; the flat config shape means the same thing.
    sasl: config.sasl as KafkaConfig["sasl"],
    // The consumer logs its own JSON line per message and per settlement; kafkajs's internal logger
    // would interleave non-JSON lines with them.
    logLevel: logLevel.NOTHING,
  });
  // kafkajs's Kafka implements this surface (and more); the cast only narrows it to what the consumer uses.
  return kafka as unknown as BrokerClient;
}
