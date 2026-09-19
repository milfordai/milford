import type { Condition, Flow, Node } from "./types.js";

/** Fluent builder that produces the plain-JSON Flow. */
export function flow(id: string) {
  const f: Flow = { id, nodes: [], edges: [] };
  const b = {
    node(nodeId: string, type: string, config?: Record<string, unknown>, opts: Partial<Omit<Node, "id" | "type" | "config">> = {}) {
      f.nodes.push({ id: nodeId, type, ...(config && { config }), ...opts });
      return b;
    },
    edge(from: string, to: string, when?: Condition) {
      f.edges.push({ from, to, ...(when && { when }) });
      return b;
    },
    build: (): Flow => f,
  };
  return b;
}
