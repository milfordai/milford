/**
 * Remembers completed runs by key so a retried request (for example a redelivered MQ message) returns the
 * first result instead of running the flow, and paying for the model calls, again.
 * In memory: per instance, bounded, and lost on restart.
 */
export function createIdempotencyStore<T>(ttlMs: number, max = 1000) {
  type Entry = { fingerprint: string; expires: number; done: Promise<T | undefined> };
  const entries = new Map<string, Entry>();
  return {
    /** The live entry for `key`, running or completed. */
    get(key: string): Entry | undefined {
      const entry = entries.get(key);
      if (entry && entry.expires <= Date.now()) return void entries.delete(key);
      return entry;
    },
    /** Registers a run. Call the returned function with the result to keep it, or with nothing to forget it. */
    begin(key: string, fingerprint: string): (result?: T) => void {
      let settle!: (value: T | undefined) => void;
      const done = new Promise<T | undefined>((resolve) => (settle = resolve));
      const entry: Entry = { fingerprint, expires: Infinity, done };
      entries.set(key, entry);
      while (entries.size > max) entries.delete(entries.keys().next().value!);
      return (result) => {
        if (result === undefined) entries.delete(key);
        else entry.expires = Date.now() + ttlMs;
        settle(result);
      };
    },
  };
}
