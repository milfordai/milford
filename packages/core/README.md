# @milford/core

The engine behind [Milford](https://github.com/milfordai/milford): flow compiler, executor, built-in nodes (`input`, `prompt`, `llm`, `decision`, `http`, `output`) and the provider port. It does no I/O of its own and knows no vendor.

```ts
import { createEngine, defaultRegistry, flow } from "@milford/core";
```

See the [documentation](https://milford.mintlify.site) and the [repository](https://github.com/milfordai/milford).
