import type { Registry } from "./registry.js";
import type { Capability, Edge, Flow, Node, Result } from "./types.js";

export type CompiledFlow = {
  flow: Flow;
  levels: Node[][];
  incoming: Map<string, Edge[]>;
  /** Parsed node configs (when compiled with a registry). */
  configs: Map<string, unknown>;
};

/** Provider id -> capabilities, used to check nodes at load time. */
export type ProviderCaps = Map<string, Capability[]>;

/** Validates the graph (and, with a registry, every node) and precomputes execution levels (Kahn's algorithm). */
export function compileFlow(flow: Flow, registry?: Registry, caps?: ProviderCaps): Result<CompiledFlow> {
  const byId = new Map<string, Node>();
  for (const node of flow.nodes) {
    if (byId.has(node.id)) return { ok: false, error: `duplicate node id "${node.id}"` };
    byId.set(node.id, node);
  }

  const incoming = new Map<string, Edge[]>(flow.nodes.map((node) => [node.id, []]));
  const outgoing = new Map<string, string[]>(flow.nodes.map((node) => [node.id, []]));
  for (const edge of flow.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) return { ok: false, error: `edge ${edge.from} -> ${edge.to} references an unknown node` };
    incoming.get(edge.to)!.push(edge);
    outgoing.get(edge.from)!.push(edge.to);
  }

  const configs = new Map<string, unknown>();
  if (registry) {
    for (const node of flow.nodes) {
      const def = registry.nodes.get(node.type);
      if (!def) return { ok: false, error: `node "${node.id}": unknown node type "${node.type}"` };

      let config: unknown = node.config ?? {};
      if (def.configSchema) {
        const parsed = def.configSchema.safeParse(config);
        if (!parsed.success) {
          const why = parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
          return { ok: false, error: `node "${node.id}" (${node.type}): ${why}` };
        }
        config = parsed.data;
      }
      configs.set(node.id, config);

      const requirement = caps && def.requires?.(config);
      if (requirement) {
        const capabilities = caps!.get(requirement.provider);
        if (!capabilities) return { ok: false, error: `node "${node.id}": unknown provider "${requirement.provider}"` };
        if (!capabilities.includes(requirement.capability)) return { ok: false, error: `node "${node.id}": provider "${requirement.provider}" cannot ${requirement.capability}` };
      }
    }
  }

  const levels: Node[][] = [];
  const pending = new Map([...incoming].map(([nodeId, edges]) => [nodeId, edges.length]));
  let ready = flow.nodes.filter((node) => pending.get(node.id) === 0);
  let seen = 0;
  while (ready.length) {
    levels.push(ready);
    seen += ready.length;
    const next: Node[] = [];
    for (const node of ready) {
      for (const target of outgoing.get(node.id)!) {
        const remaining = pending.get(target)! - 1;
        pending.set(target, remaining);
        if (remaining === 0) next.push(byId.get(target)!);
      }
    }
    ready = next;
  }
  if (seen !== flow.nodes.length) return { ok: false, error: "flow contains a cycle" };

  return { ok: true, value: { flow, levels, incoming, configs } };
}
