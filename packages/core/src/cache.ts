import type { Cache, NodeResult, RunResult } from "./types.js";

/** In-memory LRU (Map keeps insertion order). */
export function lruCache(max = 500): Cache {
  const m = new Map<string, NodeResult>();
  return {
    get(k) {
      const v = m.get(k);
      if (v) { m.delete(k); m.set(k, v); }
      return v;
    },
    set(k, v) {
      m.delete(k);
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value!);
    },
  };
}

/** Stores finished flow runs by key, for flows with `cache`. Implement it to share hits between processes. */
export interface RunCache {
  get(key: string): RunResult | undefined | Promise<RunResult | undefined>;
  set(key: string, value: RunResult, ttlMs: number): void | Promise<void>;
}

/** In-memory run cache with a TTL per entry and an LRU bound. Per process. */
export function memoryRunCache(max = 1000): RunCache {
  const m = new Map<string, { value: RunResult; expires: number }>();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      m.delete(k);
      if (e.expires <= Date.now()) return undefined;
      m.set(k, e);
      return e.value;
    },
    set(k, value, ttlMs) {
      m.delete(k);
      m.set(k, { value, expires: Date.now() + ttlMs });
      if (m.size > max) m.delete(m.keys().next().value!);
    },
  };
}

/** JSON with sorted object keys, so equal values give equal text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
