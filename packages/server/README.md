# @milfordai/server

The [Milford](https://github.com/milfordai/milford) HTTP server. The `milford-server` command reads a config file and serves flows over REST with server-sent events, idempotency keys, bearer auth and run limits.

```bash
npx @milfordai/server milford.config.yaml
```

It is described by an OpenAPI 3.1 spec, shipped in the package as `openapi.yaml`. See the [HTTP API reference](https://milford.mintlify.site/reference/http-api).
