import { Registry } from "../registry.js";
import { httpNode, inputNode, outputNode, promptNode } from "./basic.js";
import { decisionNode } from "./decision.js";
import { llmNode } from "./llm.js";

export { NONE } from "./decision.js";

/** A registry with every built-in node. */
export function defaultRegistry(): Registry {
  return new Registry()
    .registerNode("input", inputNode)
    .registerNode("prompt", promptNode)
    .registerNode("output", outputNode)
    .registerNode("http", httpNode)
    .registerNode("llm", llmNode)
    .registerNode("decision", decisionNode);
}
