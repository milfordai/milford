# @milfordai/providers

Provider adapters for [Milford](https://github.com/milfordai/milford): OpenAI and any OpenAI-compatible server, Anthropic, Jev and a generic HTTP endpoint.

```ts
import { defaultRegistry } from "@milfordai/core";
import { registerProviders } from "@milfordai/providers";

const registry = registerProviders(defaultRegistry());
```

See the [providers documentation](https://milford.mintlify.site/providers/overview).
