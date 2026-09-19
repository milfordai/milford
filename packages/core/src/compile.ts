import type { Edge, Flow, Node, Result } from "./types.js";

export type CompiledFlow = {
  flow: Flow;
  levels: Node[][];
  incoming: Map<string, Edge[]>;
};

/** Validates the graph and precomputes execution levels (Kahn's algorithm). */
export function compileFlow(flow: Flow): Result<CompiledFlow> {
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
  return { ok: true, value: { flow, levels, incoming } };
}
