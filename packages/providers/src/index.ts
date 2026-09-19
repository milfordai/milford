import type { Registry } from "@loage/core";
import { anthropic } from "./anthropic.js";
import { http } from "./http.js";
import { openai } from "./openai.js";
import { sagemaker } from "./sagemaker.js";
import { typesafe } from "./typesafe.js";

export { anthropic, http, openai, sagemaker, typesafe };

/** Registers every built-in provider type. Import a single entry point (e.g. `@loage/providers/openai`) to register just one. */
export function registerProviders(registry: Registry): Registry {
  return registry.registerProvider("openai", openai).registerProvider("anthropic", anthropic).registerProvider("typesafe", typesafe).registerProvider("http", http).registerProvider("sagemaker", sagemaker);
}
