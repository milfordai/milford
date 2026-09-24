import type { z } from "zod";
import type { Capability, NodeContext, NodeResult, ProviderFactory } from "./types.js";

export type NodeDef<C = any> = {
  /** Validated at compile time; the parsed value becomes `ctx.config`. */
  configSchema?: z.ZodType<C>;
  /** Provider the node calls, checked against provider capabilities at load time. */
  requires?: (config: C) => { provider: string; capability: Capability } | undefined;
  /**
   * Classifies a node failure as retryable, for the `retry: { on: "infra" }` policy. Return true for failures
   * that are infrastructure (timeouts, API reconnects, rate limits) or a model failing to produce a
   * structured output; false for flow problems (bad templates, bad input). Absent means no failure is
   * retried under `on: "infra"`.
   */
  retryable?: (result: NodeResult) => boolean;
  run(ctx: NodeContext<C>, upstream: Record<string, NodeResult>): Promise<NodeResult>;
};

/** Nodes and provider types are looked up by `type`; adding one never touches existing code. */
export class Registry {
  readonly nodes = new Map<string, NodeDef>();
  readonly providerTypes = new Map<string, ProviderFactory>();

  registerNode<C>(type: string, def: NodeDef<C>): this {
    this.nodes.set(type, def);
    return this;
  }
  registerProvider(type: string, factory: ProviderFactory): this {
    this.providerTypes.set(type, factory);
    return this;
  }
}
