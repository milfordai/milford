/** Minimal JSONPath: `$.a.b[0].c` only. */
export function jsonPath(value: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+/g) ?? [];
  return parts.reduce<any>((o, k) => o?.[k], value);
}
