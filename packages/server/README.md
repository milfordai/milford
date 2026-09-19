# @milford/server

The [Milford](https://github.com/milfordai/milford) HTTP server. The `milford-server` command reads a config file and serves flows over REST with server-sent events, idempotency keys, bearer auth and run limits.

```bash
npx @milford/server milford.config.yaml
```

It is described by an OpenAPI 3.1 spec. See the [HTTP API reference](https://loage.mintlify.site/reference/http-api).
