import type { NodeResult, Result } from "./types.js";

export type Scope = Record<string, unknown>;

/** Scope for templates: run input under `input`, and each upstream node's result under its id. */
export const scopeOf = (input: Record<string, unknown>, upstream: Record<string, NodeResult>): Scope => ({ ...upstream, input });

const isResult = (v: unknown): v is NodeResult => typeof v === "object" && v !== null && "success" in v;

/** Resolves a dotted path. A bare node id resolves to that node's `output`. */
export function resolve(path: string, scope: Scope): unknown {
  const v = path.split(".").reduce<any>((o, k) => o?.[k], scope);
  return isResult(v) ? v.output : v;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** Fills `{{path}}` placeholders. Unknown variables are an error, not an empty string. */
export function render(tpl: string, scope: Scope): Result<string> {
  let missing: string | undefined;
  const out = tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
    const v = resolve(path, scope);
    if (v === undefined) missing ??= path;
    return v === undefined ? "" : show(v);
  });
  return missing ? { ok: false, error: `unknown template variable "${missing}"` } : { ok: true, value: out };
}

/** Renders every string inside a JSON-like value. A string that is exactly one `{{path}}` keeps the raw value (array, number, ...). */
export function renderDeep(value: unknown, scope: Scope): Result<unknown> {
  if (typeof value === "string") {
    const path = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/)?.[1];
    if (path === undefined) return render(value, scope);
    const v = resolve(path, scope);
    return v === undefined ? { ok: false, error: `unknown template variable "${path}"` } : { ok: true, value: v };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      const r = renderDeep(v, scope);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = renderDeep(v, scope);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}
