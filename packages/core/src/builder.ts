import type { Condition, Flow, Node } from "./types.js";

/** Fluent builder that produces the plain-JSON Flow. */
export function flow(id: string) {
  const draft: Flow = { id, nodes: [], edges: [] };
  const builder = {
    node(nodeId: string, type: string, config?: Record<string, unknown>, opts: Partial<Omit<Node, "id" | "type" | "config">> = {}) {
      draft.nodes.push({ id: nodeId, type, ...(config && { config }), ...opts });
      return builder;
    },
    edge(from: string, to: string, when?: Condition) {
      draft.edges.push({ from, to, ...(when && { when }) });
      return builder;
    },
    build: (): Flow => draft,
  };
  return builder;
}
