import type { Cache, NodeResult, RunResult } from "./types.js";

/** In-memory LRU (Map keeps insertion order). */
export function lruCache(max = 500): Cache {
  const entries = new Map<string, NodeResult>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > max) entries.delete(entries.keys().next().value!);
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
  const entries = new Map<string, { value: RunResult; expires: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expires <= Date.now()) return undefined; // expired
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value!);
    },
  };
}

/** JSON with sorted object keys, so equal values give equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : 1))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonical(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
