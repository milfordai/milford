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
  for (const n of flow.nodes) {
    if (byId.has(n.id)) return { ok: false, error: `duplicate node id "${n.id}"` };
    byId.set(n.id, n);
  }
  const incoming = new Map<string, Edge[]>(flow.nodes.map((n) => [n.id, []]));
  const outgoing = new Map<string, string[]>(flow.nodes.map((n) => [n.id, []]));
  for (const e of flow.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) return { ok: false, error: `edge ${e.from} -> ${e.to} references an unknown node` };
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e.to);
  }

  const configs = new Map<string, unknown>();
  if (registry) {
    for (const n of flow.nodes) {
      const def = registry.nodes.get(n.type);
      if (!def) return { ok: false, error: `node "${n.id}": unknown node type "${n.type}"` };
      let config: unknown = n.config ?? {};
      if (def.configSchema) {
        const p = def.configSchema.safeParse(config);
        if (!p.success) {
          const why = p.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
          return { ok: false, error: `node "${n.id}" (${n.type}): ${why}` };
        }
        config = p.data;
      }
      configs.set(n.id, config);
      const need = caps && def.requires?.(config);
      if (need) {
        const have = caps!.get(need.provider);
        if (!have) return { ok: false, error: `node "${n.id}": unknown provider "${need.provider}"` };
        if (!have.includes(need.capability)) return { ok: false, error: `node "${n.id}": provider "${need.provider}" cannot ${need.capability}` };
      }
    }
  }

  const levels: Node[][] = [];
  const pending = new Map([...incoming].map(([id, es]) => [id, es.length]));
  let ready = flow.nodes.filter((n) => pending.get(n.id) === 0);
  let seen = 0;
  while (ready.length) {
    levels.push(ready);
    seen += ready.length;
    const next: Node[] = [];
    for (const n of ready)
      for (const to of outgoing.get(n.id)!) {
        const left = pending.get(to)! - 1;
        pending.set(to, left);
        if (left === 0) next.push(byId.get(to)!);
      }
    ready = next;
  }
  if (seen !== flow.nodes.length) return { ok: false, error: "flow contains a cycle" };
  return { ok: true, value: { flow, levels, incoming, configs } };
}
