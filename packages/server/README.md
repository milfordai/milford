# @loage/server

The [Loage](https://github.com/loage-ai/loage) HTTP server. The `loage-server` command reads a config file and serves flows over REST with server-sent events, idempotency keys, bearer auth and run limits.

```bash
npx @loage/server loage.config.yaml
```

It is described by an OpenAPI 3.1 spec. See the [HTTP API reference](https://loage.mintlify.site/reference/http-api).
