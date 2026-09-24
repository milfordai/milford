# Queue consumption (Apache Kafka)

Every message on the `orders` topic runs the `process-order` flow once. A JSON object message body becomes the flow input directly; anything else arrives as `{ payload: <text> }`. A successful run commits the message; a failing one is redelivered with backoff and dead-lettered once the configured attempts run out. Delivery is at-least-once: a message is acknowledged only after its flow finished.

If you installed `@milfordai/server` from npm, also install the Kafka adapter (`@milfordai/queues-kafka`) in the same project; the server only dev-depends on it so the default install stays lean.

## Run it

1. Start a local broker — one command, no other infrastructure:

   ```
   docker run -d --name milford-kafka -p 9092:9092 apache/kafka:3.9.0
   ```

2. Start Milford from the repository root (build it first with `pnpm -r build`):

   ```
   node packages/server/dist/cli.js examples/queue-kafka/milford.config.yaml
   ```

   It prints `1 flow(s), 0 channel(s), 1 queue consumer(s), listening on :8080` once the consumer group has joined.

3. Produce a message — topics are auto-created, so this works right away. Type the message, then Enter, then Ctrl-D:

   ```
   docker exec -i milford-kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic orders
   {"order": 7}
   ```

Milford logs one JSON line per run, for example:

```
{"level":"info","msg":"run","consumer":"orders","flow":"process-order","ok":true,"runId":"…","messageId":"orders/0/0","deliveryCount":1}
```

## What to notice

- Ctrl-C stops Milford gracefully: in-flight runs are aborted, their messages are left uncommitted and so redelivered on the next start.
- A broker that is down stops startup with a clear error instead of a server that consumes nothing.
- Rejected messages land on `orders.dlq` with headers recording the original topic, partition, offset, delivery count and error. Read them back with:

  ```
  docker exec milford-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders.dlq --from-beginning
  ```

Clean up with `docker rm -f milford-kafka`.
