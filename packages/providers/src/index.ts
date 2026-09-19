import type { Registry } from "@loage/core";
import { anthropic } from "./anthropic.js";
import { http } from "./http.js";
import { openai } from "./openai.js";
import { typesafe } from "./typesafe.js";

export { anthropic, http, openai, typesafe };

/** Registers every built-in provider type. */
export function registerProviders(registry: Registry): Registry {
  return registry.registerProvider("openai", openai).registerProvider("anthropic", anthropic).registerProvider("typesafe", typesafe).registerProvider("http", http);
}
