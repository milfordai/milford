# @loage/core

The engine behind [Loage](https://github.com/loage-ai/loage): flow compiler, executor, built-in nodes (`input`, `prompt`, `llm`, `decision`, `http`, `output`) and the provider port. It does no I/O of its own and knows no vendor.

```ts
import { createEngine, defaultRegistry, flow } from "@loage/core";
```

See the [documentation](https://loage.mintlify.site) and the [repository](https://github.com/loage-ai/loage).
