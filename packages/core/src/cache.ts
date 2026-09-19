import type { Cache, NodeResult } from "./types.js";

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
