# @milfordai/queues-kafka

Queue consumption for [Milford](https://github.com/milfordai/milford): an Apache Kafka consumer that runs a flow per message, with at-least-once delivery, redelivery with backoff, dead letters and duplicate suppression.

The published `@milfordai/server` only **dev-depends** on this package so the default install stays lean. To consume Kafka queues, install the adapter next to the server:

```bash
npm install @milfordai/server @milfordai/queues-kafka
```

Then add a `queues:` entry to `milford.config.yaml`:

```yaml
queues:
  - id: orders
    type: kafka
    flow: process-order
    brokers: ["localhost:9092"]
    topics: [orders]
    groupId: milford-orders
    deadLetterTopic: orders.dlq
    retry: { attempts: 3, backoffMs: 1000, multiplier: 2 }
    concurrency: 2
```

## Config keys

| Key | Required | Default | Description |
| --- | --- | --- | --- |
| `id` | yes | — | Unique consumer id across the server. |
| `type` | yes | — | Must be `kafka`. |
| `flow` | yes | — | Flow id to run once per message. |
| `brokers` | yes | — | Kafka bootstrap addresses, e.g. `["broker:9092"]`. |
| `topics` | yes | — | Topics to consume. |
| `groupId` | yes | — | Consumer group id; offsets and redeliveries are per group. |
| `clientId` | no | `milford` | Client id the broker sees. |
| `ssl` | no | `false` | Enable TLS for the common case. |
| `sasl` | no | — | `{ mechanism: "plain" | "scram-sha-256" | "scram-sha-512", username, password }`. |
| `deadLetterTopic` | no | — | Topic to produce rejected messages to. Unset means drop after logging. |
| `retry.attempts` | yes | `1` | Deliveries of one message, including the first, before it is rejected. |
| `retry.backoffMs` | no | `0` | Delay before the first redelivery, in milliseconds. |
| `retry.multiplier` | no | `2` | Growth per redelivery. |
| `retry.maxBackoffMs` | no | — | Cap on each redelivery delay. |
| `retry.jitterMs` | no | `0` | Random plus/minus added to each delay. |
| `concurrency` | no | `1` | Partitions processed in parallel. Order within a partition is always preserved. |
| `maxInFlight` | no | `concurrency` | Messages received but not yet settled, held at once. When the limit is reached the consumer stops handing messages to flows until messages settle. |
| `timeoutMs` | no | engine default | Per-run timeout override. |
| `idempotencyTtlMs` | no | `600000` | How long a processed message id is remembered, so a redelivered message is acknowledged without another run. `0` disables. |

Every message runs the configured flow with the message body as the flow input. A JSON object body becomes the input itself; anything else arrives as `{ payload: <text> }`. A successful run commits the message; a failing run is redelivered with backoff and dead-lettered once the attempts run out. See `examples/queue-kafka` in the repository for a runnable setup.
