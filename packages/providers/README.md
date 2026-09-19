# @loage/providers

Provider adapters for [Loage](https://github.com/loage-ai/loage): OpenAI and any OpenAI-compatible server, Anthropic, Jev and a generic HTTP endpoint.

```ts
import { defaultRegistry } from "@loage/core";
import { registerProviders } from "@loage/providers";

const registry = registerProviders(defaultRegistry());
```

See the [providers documentation](https://loage.mintlify.site/providers/overview).
